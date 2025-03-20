# OpenChat

<div align="center">
  <img src="https://via.placeholder.com/150" alt="OpenChat Logo" width="150"/>
  <br>
  <strong>A secure, decentralized messaging platform</strong>
  <br>
  <br>

  [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/openchat)
  ![License](https://img.shields.io/github/license/rpi10/openchatv2)
  ![Stars](https://img.shields.io/github/stars/rpi10/openchatv2?style=social)
  
</div>

## 📋 Overview

OpenChat is a modern messaging application built with privacy and security at its core. Unlike traditional messaging platforms, OpenChat uses a fully decentralized architecture to ensure your conversations remain private, secure, and free from censorship.

### Key Features

- **End-to-End Encryption**: All messages are encrypted using state-of-the-art cryptographic algorithms
- **Decentralized Architecture**: No central servers to compromise or monitor your communications
- **Secure File Sharing**: Share files of any size with BackBlaze encrypted storage integration
- **Easy Deployment**: Deploy your own instance in minutes using our Railway template
- **Open Source**: Fully transparent codebase that anyone can inspect, modify, and contribute to

## 🚀 Quick Start

### Deploy Your Own Instance

The fastest way to get started is by deploying OpenChat on Railway:

1. Click the "Deploy on Railway" button at the top of this README
2. Sign in to your Railway account (or create one)
3. Configure your environment variables (see [Configuration](#-configuration) section below)
4. Click deploy and wait for the build to complete
5. Access your OpenChat instance via the provided URL

### Local Development

To run OpenChat locally for development:

```bash
# Clone the repository
git clone https://github.com/rpi10/openchatv2.git
cd openchatv2

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit the .env file with your configuration

# Start the development server
npm run dev
```

## 🛠️ Configuration

OpenChat requires the following environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `BACKBLAZE_KEY_ID` | Your BackBlaze B2 key ID | Yes |
| `BACKBLAZE_APP_KEY` | Your BackBlaze B2 application key | Yes |
| `BACKBLAZE_BUCKET_NAME` | The name of your BackBlaze B2 bucket | Yes |
| `JWT_SECRET` | Secret key for JWT token generation | Yes |
| `NODE_ENV` | Environment (development/production) | No (defaults to development) |
| `PORT` | Port to run the server on | No (defaults to 3000) |

## 🏗️ Architecture

OpenChat uses a decentralized architecture to ensure privacy and security:

1. **Client-Side Encryption**: All message content is encrypted on the sender's device before transmission
2. **P2P Communication**: Messages are sent directly between peers when possible
3. **BackBlaze Storage**: For file sharing and offline message delivery, encrypted data is stored in BackBlaze B2 buckets
4. **No Central Message Storage**: Messages are never stored on central servers in unencrypted form

## 📁 Project Structure

```
openchatv2/
├── client/              # Frontend React application
├── server/              # Backend Node.js server
│   ├── controllers/     # Request handlers
│   ├── models/          # Data models
│   ├── routes/          # API routes
│   └── services/        # Business logic
├── shared/              # Shared utilities and types
├── docs/                # Documentation
├── scripts/             # Utility scripts
└── tests/               # Test suite
```

## 🧪 Testing

Run the test suite with:

```bash
npm test
```

For integration tests:

```bash
npm run test:integration
```

## 🤝 Contributing

Contributions are welcome! Please check out our [Contributing Guidelines](CONTRIBUTING.md) for details on how to get started.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔒 Security

Found a security vulnerability? Please do not create a public issue. Instead, send an email to [security@example.com](mailto:security@example.com) with details.

## 🙏 Acknowledgements

- Thanks to [BackBlaze](https://www.backblaze.com/) for their B2 Cloud Storage
- Thanks to [Railway](https://railway.app/) for their deployment platform

## 📞 Contact

- GitHub: [@rpi10](https://github.com/rpi10)
- Issues: [https://github.com/rpi10/openchatv2/issues](https://github.com/rpi10/openchatv2/issues)
- Discussions: [https://github.com/rpi10/openchatv2/discussions](https://github.com/rpi10/openchatv2/discussions)
