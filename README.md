# Codex Local Assistant

A local coding assistant app with a Node/Express API server and a Vite React client.

## What You Need

Install these before running the app:

- Node.js 18 or newer from https://nodejs.org
- npm, which is included with Node.js
- An OpenAI API key, added inside the app after it opens

You do not need to install anything separately inside `client` or `server`. Run every command below from the main project folder, the one that contains this README.

## Start The App

Pick the one command for your computer. The start command checks for Node.js, installs missing dependencies, and launches the local app.

### macOS, Linux, WSL, or Git Bash

```bash
bash start.sh
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Then open:

```text
http://localhost:5173
```

The web app runs on `http://localhost:5173`, and the API server runs on `http://localhost:8787`.

You can also run the app directly with npm:

```bash
npm run dev
```

If dependencies are missing, `npm run dev` installs them automatically before starting.

## Clean Reinstall

Use this when dependencies seem broken or you want to reset the local install.

### macOS, Linux, WSL, or Git Bash

```bash
bash start.sh --clean
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Clean
```

## Using The App

1. Open `http://localhost:5173`.
2. Add your OpenAI API key in Settings.
3. Select the local workspace folder you want the assistant to work in.
4. Start a chat.

## Troubleshooting

- If startup says Node.js is missing or too old, install the current LTS version from https://nodejs.org and run the start command again.
- If `npm run dev` says a port is already in use, close the old terminal running the app and try again.
- If dependencies fail after an update, run the clean reinstall command for your computer.
