Deskly is one Windows application with two modes:

- **Host:** runs on the computer to be controlled. It can stay in the Windows notification area and accepts connections using its Deskly ID and access password.
- **Controller:** runs on the computer you are using. It connects to a Host by ID and saved access password.

## Build the Windows installer

From the main Deskly folder, run:

```powershell
npm install --prefix desktop
npm run desktop:installer
```

The single installer will be created in `desktop/release`. Install the same file on both computers. On first launch, choose either **Controlled PC (Host)** or **Controller**; the app remembers its account and settings.

## Production deployment

1. Create a MongoDB Atlas database and add the API server's public IP under **Network Access**.
2. Deploy the `api` folder to an always-on Node.js host. Set `MONGO_URI`, `JWT_SECRET`, and `PORT` as private environment variables. Never commit `api/.env`.
3. Give the API a public HTTPS address, for example `https://api.example.com`.
4. On each installed Deskly computer, create `%APPDATA%\Deskly\deskly.config.json` containing:

```json
{ "apiUrl": "https://api.example.com" }
```

5. Restart Deskly. Both Host and Controller will use the deployed API.

For direct P2P sessions, normal internet traffic uses only the API for connection setup. A public TURN relay is still required for reliable connections through restrictive routers or corporate networks.

## Run on this computer

1. Make sure MongoDB is running (it already is if Windows shows the MongoDB service as Running).
2. Double-click `install.bat` once (installs the app libraries).
3. Double-click `start-api.bat` and leave that window open.
4. On the PC you want to control, double-click `start-host.bat`.
5. On the PC you use as the remote keyboard/mouse, double-click `start-controller.bat`.

First launch: create your username and password. The host window shows an ID. On the controller, type that ID and the access password. There is no Accept popup.

## Run the host in the background

The controlled PC starts tray-only: no Command Prompt or Deskly window is shown once it is set up. Use `start-host.bat` (or `start-host-hidden.vbs`) to run it. Click the Deskly icon in the Windows notification area to open the settings/ID window when needed. Closing that window hides it instead of stopping the host; use **Exit Deskly** from the tray menu when you deliberately want to stop it.

Pause sending mouse/keyboard: Ctrl+Alt+Q or type :qw
Resume: Ctrl+Alt+E or type :qe
The Windows key from the controller is blocked.

## Session controls

- **Pause / resume:** the Controller shows the current state and the Host confirms that it is accepting or ignoring input.
- **Both cursors follow:** switch this on or off from the session bar. Deskly suppresses mirrored movements briefly to prevent cursor bouncing.
- **Screen size:** choose Adaptive (default), 720p, or 1080p before connecting.
- **Recent devices:** successfully connected IDs are saved in MongoDB; choose one to refill its ID quickly. Passwords are never saved in history.
- **Account:** use the header **Log out** button, or **Stop Host & log out** from the Host panel. Change the account password from Settings.

API uses local MongoDB: mongodb://127.0.0.1:27017/deskly

## Testing from another PC on this hotspot

The shared API address is in `deskly.config.json`. It is set to `http://192.168.137.1:3780`, which is this PC's hotspot address. Copy the whole Deskly folder (including that file) to the testing PC, run `install.bat`, then start the controller. On the testing PC, do **not** start `start-api.bat` or MongoDB: it uses the API running on this PC.
