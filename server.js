const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 9876;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

let currentCarouselIndex = 0;
let savedDisplays = {};

// Jellyfin 12 disables legacy api_key authentication by default.
function jellyfinAuthorization(displayId, token) {
    const quote = value => JSON.stringify(String(value));
    const fields = [
        'Client="Theater Poster Display"',
        'Device="Portrait Screen"',
        `DeviceId=${quote(displayId)}`,
        'Version="1.1.0"'
    ];
    if (token) fields.push(`Token=${quote(token)}`);
    return `MediaBrowser ${fields.join(', ')}`;
}

async function jellyfinFetch(profile, endpoint) {
    const response = await fetch(`${profile.serverUrl.replace(/\/+$/, '')}${endpoint}`, {
        headers: { Authorization: jellyfinAuthorization(profile.displayId || 'default', profile.token) }
    });
    if (!response.ok) {
        const error = new Error(`Jellyfin returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response;
}

function sendJellyfinError(res, error) {
    const status = [401, 403, 404].includes(error.status) ? error.status : 502;
    res.status(status).json({ error: status === 401
        ? 'Jellyfin authentication expired. Save your server configuration again.'
        : `Jellyfin request failed${error.status ? ` (HTTP ${error.status})` : ''}.` });
}

function loadConfigFromDisk() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const fileData = fs.readFileSync(CONFIG_FILE, 'utf8');
            savedDisplays = JSON.parse(fileData);
            console.log(`[OK] Loaded ${Object.keys(savedDisplays).length} saved server profiles from disk.`);
        }
    } catch (err) {
        console.error("Failed to parse config.json, starting with empty slate:", err);
    }
}

function saveConfigToDisk() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(savedDisplays, null, 4), 'utf8');
    } catch (err) {
        console.error("Failed to write configurations to disk:", err);
    }
}

function getDisplayProfile(req) {
    const displayId = req.query.displayId || req.headers['x-display-id'] || 'default';
    return savedDisplays[displayId] || null;
}

app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html', // <-- Tells Express to serve art.html at "/"
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
}));

app.post('/api/auth/save-config', async (req, res) => {
    try {
        const { displayId, serverUrl, username, password } = req.body;
        const targetId = displayId || 'default';

        if (!serverUrl || !username) {
            return res.status(400).json({ error: 'Missing Server URL or Username parameters.' });
        }

        const authHeader = jellyfinAuthorization(targetId);
        
        console.log(`Attempting connection to ${serverUrl} for user: ${username}...`);
        const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify({ Username: username, Pw: password })
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Jellyfin authentication denied.' });
        }

        const data = await response.json();
        
        savedDisplays[targetId] = {
            serverUrl: serverUrl.replace(/\/+$/, ''),
            displayId: targetId,
            token: data.AccessToken,
            username: username,
            pollInterval: 5000,
            pausedRotateInterval: 20000,
            idleRotateInterval: 20000,
            ignorePaused: false          // New Configuration Flag: Default to showing paused states
        };

        saveConfigToDisk();
        console.log(`[SUCCESS] Configuration locked server-side for profile ID: "${targetId}"`);

        res.json({ success: true, displayId: targetId });
    } catch (error) {
        console.error('Server setup connection failed:', error);
        res.status(500).json({ error: 'Could not resolve or reach target Jellyfin server.' });
    }
});

app.get('/api/auth/check', (req, res) => {
    const profile = getDisplayProfile(req);
    if (profile) {
        res.json({ 
            authenticated: true, 
            username: profile.username, 
            serverUrl: profile.serverUrl,
            intervals: {
                poll: profile.pollInterval || 5000,
                paused: profile.pausedRotateInterval || 20000,
                idle: profile.idleRotateInterval || 20000
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// SESSIONS ENDPOINT: Now processes the ignorePaused flag
app.get('/api/sessions', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(401).json({ error: 'Unconfigured Display Profile' });

    try {
        const response = await jellyfinFetch(profile, '/Sessions');
        let data = await response.json();
        
        if (Array.isArray(data)) {
            // Check if this display profile is explicitly set to drop paused items
            if (profile.ignorePaused === true) {
                data = data.filter(session => session.NowPlayingItem && !session.PlayState?.IsPaused);
            } else {
                data.forEach(session => {
                    if (session.NowPlayingItem) {
                        session.NowPlayingItem.PosterTargetId = session.NowPlayingItem.SeriesId || session.NowPlayingItem.Id;
                    }
                });
            }
        }
        
        res.json({
            sessions: data,
            intervals: {
                poll: profile.pollInterval || 5000,
                paused: profile.pausedRotateInterval || 20000,
                idle: profile.idleRotateInterval || 20000
            }
        }); 
    } catch (error) {
        sendJellyfinError(res, error);
    }
});

// POSTER PROXY
app.get('/api/poster/:itemId', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const imageUrl = `/Items/${encodeURIComponent(req.params.itemId)}/Images/Primary?maxWidth=1000&quality=85`;
        const response = await jellyfinFetch(profile, imageUrl);
        res.setHeader('Content-Type', response.headers.get('content-type'));
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        sendJellyfinError(res, error);
    }
});

// AVATAR PROXY
app.get('/api/avatar/:userId', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const avatarUrl = `/Users/${encodeURIComponent(req.params.userId)}/Images/Primary?maxWidth=200&quality=95`;
        const response = await jellyfinFetch(profile, avatarUrl);
        res.setHeader('Content-Type', response.headers.get('content-type'));
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        sendJellyfinError(res, error);
    }
});

// INTERMISSION RANDOM POSTERS
app.get('/api/random-poster', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const params = new URLSearchParams({
            IncludeItemTypes: 'Movie',
            Recursive: 'true',
            ImageTypes: 'Primary',
            SortBy: 'DateCreated',    
            SortOrder: 'Descending', 
            Limit: '50'              
        });

        const response = await jellyfinFetch(profile, `/Items?${params.toString()}`);
        const data = await response.json();

        if (data.Items && data.Items.length > 0) {
            if (currentCarouselIndex >= data.Items.length) currentCarouselIndex = 0;
            const recentItem = data.Items[currentCarouselIndex++];
            
            const imageUrl = `/Items/${encodeURIComponent(recentItem.Id)}/Images/Primary?maxWidth=1000&quality=85&cb=${Date.now()}`;
            const imageResponse = await jellyfinFetch(profile, imageUrl);
            res.setHeader('Content-Type', imageResponse.headers.get('content-type'));
            res.send(Buffer.from(await imageResponse.arrayBuffer()));
        } else {
            res.status(404).send('No posters matched inside library indexes.');
        }
    } catch (error) {
        sendJellyfinError(res, error);
    }
});

// 8. PORTRAIT-SPECIFIC MUSEUM ART INTERMISSION ENDPOINT
app.get('/api/art', async (req, res) => {
    try {
        // Step 1: Query for public domain paintings. 
        // We'll grab a larger list (limit: 100) to ensure we have plenty of choices after filtering.
        const fields = 'id,title,artist_title,image_id,dimensions';
        const museumUrl = `https://api.artic.edu/api/v1/artworks/search?q=painting&query[term][is_public_domain]=true&fields=${fields}&limit=100`;

        const response = await fetch(museumUrl);
        if (!response.ok) throw new Error('Museum API connection failed');
        
        const data = await response.json();
        const artworks = data.data || [];

        // Step 2: Extract and filter out non-portrait assets in memory
        const portraitArtworks = artworks.filter(art => {
            // Ensure it actually has an image identifier and dimensions string
            if (!art.image_id || !art.dimensions) return false;

            try {
                // The museum dimensions string typically looks like: "200 × 150 cm (78 3/4 × 59 in.)"
                // We use a regular expression to find the first two numbers (Height × Width)
                const matches = art.dimensions.match(/([0-9.,]+)\s*[×xX]\s*([0-9.,]+)/);
                if (matches) {
                    const height = parseFloat(matches[1].replace(/,/g, ''));
                    const width = parseFloat(matches[2].replace(/,/g, ''));
                    
                    // Strictly match portrait layout (Height must be greater than Width)
                    // You can adjust the ratio multiplier (e.g., height > width * 1.2) for narrow frames
                    return height > width; 
                }
            } catch (err) {
                // If parsing a weird dimension text format fails, skip the item safely
                return false;
            }
            return false;
        });

        // Step 3: Check if our filtered stack has items, fallback if empty
        const finalPool = portraitArtworks.length > 0 ? portraitArtworks : artworks;

        // Step 4: Pick a random portrait masterpiece
        const randomIndex = Math.floor(Math.random() * finalPool.length);
        const selectedArt = finalPool[randomIndex];

        // Step 5: Format the IIIF pipeline parameters
        const baseConfigUrl = data.config.iiif_url;
        const finalImageUrl = `${baseConfigUrl}/${selectedArt.image_id}/full/843,/0/default.jpg`;

        res.json({
            title: selectedArt.title || "Untitled",
            artist: selectedArt.artist_title || "Unknown Artist",
            imageUrl: finalImageUrl
        });

    } catch (error) {
        console.error("Failed fetching portrait artwork metadata:", error);
        
        // Portrait-safe layout fallback option
        res.json({
            title: "Vase of Flowers",
            artist: "Jan Davidsz de Heem",
            imageUrl: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1000&auto=format&fit=crop&q=80"
        });
    }
});

loadConfigFromDisk();

if (require.main === module) app.listen(PORT, () => {
    console.log(`[OK] Server-side saved portal configuration active on port ${PORT}`);
});

module.exports = app;
