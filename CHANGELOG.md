## 1.1.0

### Breaking change ❗️

Support multiple providers: Ollama (default), OpenAI, Anthropic, Google, Custom (OpenAI Compatible), OpenClaw (Experimental). You can choose another provider by using a custom host and API key.

The previous "via Custom Host" option is now: Select Ollama as Provider → Enter your local Ollama server address in Host (e.g. http://localhost:11434)

The previous "via Ollama Cloud" option is now: Select Ollama as Provider → Enter https://ollama.com in Host → Enter your Ollama Cloud API Key in API Key

### Features 🚀

- Now uses Vercel AI SDK for better AI application development
- Automatically discover available models based on the selected Provider
- Support regenerating individual messages
- Support selecting and copying markdown content by range
- Added voice input
- Added token usage statistics
- Improved multi-conversation management
- Improved historical configuration management
- Settings page UI redesign

### Bug fix 🐛

- Fixed an error with reasoning configuration when selecting the "qwen3-next:80b" model in Ollama
- Optimized potential device overheating issue on certain iOS devices during long conversations

## 1.0.0

### Features 🚀

- Clean, unified UI that feels just like the official clients.
- Focused on the essentials so you can start chatting immediately.
- Chats and settings never leave the device.
- Quickly enable [thinking mode](https://docs.ollama.com/capabilities/thinking) whenever deeper reasoning is needed.
- Watch answers stream in token by token for instant feedback.
- A polished experience that respects system theme preferences.
- Code blocks, tables, LaTeX, and more render beautifully.
- Jump back into any conversation instantly.
- Follow ongoing chats directly from the home/lock screen.
