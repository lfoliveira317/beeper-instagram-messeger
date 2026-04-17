# Beeper Instagram Messenger

A web-based dashboard to send Instagram Direct Messages in bulk via the **Beeper Desktop HTTP API**.

> Inspired by [copilot-messenger](https://github.com/lfoliveira317/copilot-messenger), adapted for Instagram via Beeper.

## Features

- 📋 Manage a list of Instagram recipients (add, import, delete)
- 🔄 Load recipients directly from your Beeper Instagram chats
- 📢 Broadcast messages to selected recipients or all at once
- ⏱️ Configurable delay between messages to avoid rate limits
- 📊 Real-time activity log
- 🌙 Modern dark-themed UI

## Requirements

- [Node.js](https://nodejs.org/) v18+
- [Beeper Desktop](https://beeper.com/) running locally

## Setup

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/lfoliveira317/beeper-instagram-messeger.git
   cd beeper-instagram-messeger
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your token:
   ```bash
   cp .env.example .env
   ```

   Get your token from Beeper Desktop → Settings → Advanced → Access Token.

3. Start the server:
   ```bash
   npm start
   ```

4. Open [http://localhost:3600](http://localhost:3600) in your browser.

## Usage

### Adding Recipients

- **Manually**: Click ➕ Add, fill in the chat ID and name.
- **Import JSON**: Click 📥 Import JSON and paste or upload a JSON array.
- **Load from Beeper**: Click 🔄 Load from Beeper to fetch your Instagram chats automatically.

### Sending Messages

1. Select recipients using checkboxes.
2. Type your message.
3. Adjust the delay slider (1–10 seconds between sends).
4. Click **📢 Broadcast to Selected** or **📨 Send to All**.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Check Beeper connection |
| GET | `/api/chats` | List Instagram chats from Beeper |
| POST | `/api/send` | Send to one chat `{ chatId, message }` |
| POST | `/api/broadcast` | Broadcast `{ message, ids?, delay? }` |
| GET | `/api/recipients` | List recipients |
| POST | `/api/recipients` | Add recipient |
| POST | `/api/recipients/import` | Bulk import |
| PUT | `/api/recipients/:id` | Update recipient |
| DELETE | `/api/recipients/:id` | Delete recipient |

## License

MIT
