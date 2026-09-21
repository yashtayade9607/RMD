# McAfee deployment

## 1. Deploy the API

Run the `api` application on an always-on server with MongoDB available. Set these environment variables there:

- `MONGO_URI`
- `JWT_SECRET`
- `PORT`

Expose the API through HTTPS. The API server must remain online for devices to sign in and establish new connections.

## 2. Install the Windows application

Copy `desktop/release-McAfee/McAfee-Setup-0.1.0.exe` to each Windows computer and run it. Install the same package on the Host and Controller.

If Windows SmartScreen appears, the installer is unsigned. Verify the installer hash from the release process before choosing **More info** and **Run anyway**.

## 3. Point each computer to the deployed API

Create this file after the first launch:

`%APPDATA%\McAfee\deskly.config.json`

```json
{ "apiUrl": "https://your-api.example.com" }
```

Restart McAfee after saving the file.

## 4. Configure the persistent Host

1. Launch McAfee on the controlled computer and select **Share Screen (Host)**.
2. Sign in or create the account, then record the displayed device ID and access password.
3. Enable **Run in background and start automatically when I sign in**.
4. Close the window. McAfee remains available in the Windows notification area and starts tray-only at every later sign-in.

To stop the currently running Host, use **Exit McAfee** from the tray menu. To also stop it from launching at later sign-ins, open McAfee and disable the background startup setting.

## 5. Configure the Controller

1. Launch McAfee on the controlling computer and select **Control Remote PC**.
2. Sign in with the appropriate account.
3. Enter the Host device ID and access password, then connect.

Use `Ctrl+Alt+Q` on the Host to pause remote input, `Ctrl+Alt+E` to resume it, and `Ctrl+Alt+;` to immediately terminate the Host application.
