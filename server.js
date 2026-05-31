const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 9876;
const CONFIG_FILE = path.join(__dirname, 'config.json');

let currentCarouselIndex = 0;
let savedDisplays = {};

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

        const authHeader = `MediaBrowser Client="Theater Poster Display", Device="Portrait Screen", DeviceId="${targetId}", Version="1.0.0"`;
        
        console.log(`Attempting connection to ${serverUrl} for user: ${username}...`);
        const response = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
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
            serverUrl: serverUrl,
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
        const response = await fetch(`${profile.serverUrl}/Sessions?api_key=${profile.token}`);
        let data = await response.json();
        
        if (Array.isArray(data)) {
            // Check if this display profile is explicitly set to drop paused items
            if (profile.ignorePaused === true) {
                data = data.filter(session => session.NowPlayingItem && !session.PlayState.IsPaused);
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
        res.status(500).json({ error: 'API fetch connection down.' });
    }
});

// POSTER PROXY
app.get('/api/poster/:itemId', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const imageUrl = `${profile.serverUrl}/Items/${req.params.itemId}/Images/Primary?api_key=${profile.token}&maxWidth=1000&quality=85`;
        const response = await fetch(imageUrl);
        res.setHeader('Content-Type', response.headers.get('content-type'));
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        res.status(500).send('Error rendering asset image proxy');
    }
});

// AVATAR PROXY
app.get('/api/avatar/:userId', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const avatarUrl = `${profile.serverUrl}/Users/${req.params.userId}/Images/Primary?api_key=${profile.token}&maxWidth=200&quality=95`;
        const response = await fetch(avatarUrl);
        res.setHeader('Content-Type', response.headers.get('content-type'));
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        res.status(500).send('Error rendering user icon proxy');
    }
});

// INTERMISSION RANDOM POSTERS
app.get('/api/random-poster', async (req, res) => {
    const profile = getDisplayProfile(req);
    if (!profile) return res.status(412).send('Unconfigured profile');

    try {
        const params = new URLSearchParams({
            api_key: profile.token,
            IncludeItemTypes: 'Movie',
            Recursive: 'true',
            ImageTypes: 'Primary',
            SortBy: 'DateCreated',    
            SortOrder: 'Descending', 
            Limit: '50'              
        });

        const response = await fetch(`${profile.serverUrl}/Items?${params.toString()}`);
        const data = await response.json();

        if (data.Items && data.Items.length > 0) {
            if (currentCarouselIndex >= data.Items.length) currentCarouselIndex = 0;
            const recentItem = data.Items[currentCarouselIndex++];
            
            const imageUrl = `${profile.serverUrl}/Items/${recentItem.Id}/Images/Primary?api_key=${profile.token}&maxWidth=1000&quality=85&cb=${Date.now()}`;
            const imageResponse = await fetch(imageUrl);
            res.setHeader('Content-Type', imageResponse.headers.get('content-type'));
            res.send(Buffer.from(await imageResponse.arrayBuffer()));
        } else {
            res.status(404).send('No posters matched inside library indexes.');
        }
    } catch (error) {
        res.status(500).send('Carousel pipeline exception encountered');
    }
});

loadConfigFromDisk();

app.listen(PORT, () => {
    console.log(`[OK] Server-side saved portal configuration active on port ${PORT}`);
});
