# Jellyposter

A portrait poster display for Jellyfin, with now-playing sessions, user avatars,
a recent-movie carousel, and an art display at `/art.html`.

Start with `docker compose up -d`, then open `http://localhost:9876` and save your
Jellyfin server URL and credentials. Include any configured base path in the URL
(for example, `https://media.example.com/jellyfin`).

Jellyfin 12 compatibility: all Jellyfin requests use the supported
`Authorization: MediaBrowser ... Token="..."` header instead of the legacy
`api_key` query parameter. Existing profiles in `config.json` continue to work;
if Jellyfin rejects a saved token, save the server configuration again. The
Jellyfin account needs permission to view the sessions you want to display.
See the [Jellyfin 12 release notes](https://jellyfin.org/posts/jellyfin-release-12.0/)
for the server's authentication changes.

After updating this checkout, restart the running app with
`docker compose restart poster-backend`.

Run the integration test with `node --test`. It uses mocked Jellyfin responses
and a temporary configuration file, without connecting to your media server.
