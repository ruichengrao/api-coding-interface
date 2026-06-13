# Codex Local Assistant

A local web app for chatting with an OpenAI-powered coding assistant.

The app runs on your machine:

- UI: `http://localhost:5173`
- API server: `http://localhost:8787`

## Requirements

- Node.js 18 or newer: https://nodejs.org
- Python 3: https://www.python.org
- An OpenAI API key

## Start

Run commands from this project folder.

### macOS or Windows WSL

```bash
bash start.sh
```

### Windows PowerShell

```powershell
python run_api.py
```

The launcher installs dependencies if needed, starts the app, and opens your browser.

If the browser does not open, go to:

```text
http://localhost:5173
```

## First Use

1. Create a new chat.
2. Add your OpenAI API key.
3. Choose and validate the local project folder the assistant can work in.
4. Send a message.

## Stop

Press `Ctrl+C` in the terminal.

## Clean Restart

Use this if ports are stuck or dependencies look broken.

macOS or Windows WSL:

```bash
bash start.sh --clean
```

Windows PowerShell:

```powershell
python run_api.py --clean
```

## Common Issues

- `npm` missing: install Node.js, then reopen your terminal.
- `python` missing: install Python 3, then reopen your terminal.
- Port already in use: run the clean restart command above.
