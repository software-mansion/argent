# Simulator Setup

Set up and start the radon-lite tools server and connect to an iOS simulator.

## Steps

1. **Check if tools server is running**
   ```bash
   curl -s http://localhost:3001/tools | jq '.tools[].name'
   ```
   If that fails, start it:
   ```bash
   cd packages/tools && npm start &
   ```

2. **Find a booted simulator**
   Use the `list-simulators` tool to find a simulator with `state: "Booted"`.
   If none are booted, use `boot-simulator` with the desired UDID.

3. **Start simulator-server for the UDID**
   Use the `simulator-server` tool with the UDID (and optionally a JWT token for Pro features).
   This returns `{ apiUrl, streamUrl }`.

4. **Verify connection**
   The `streamUrl` points to an MJPEG stream you can open in a browser.
   All interaction tools (`tap`, `swipe`, `gesture`, etc.) will auto-start the server if needed.

## Notes

- The tools server runs at `http://localhost:3001` by default
- All tools auto-start `simulator-server` if not already running (without a token)
- For screenshot/recording, pass a JWT token to `simulator-server` or `screenshot` directly
- UDIDs look like: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
