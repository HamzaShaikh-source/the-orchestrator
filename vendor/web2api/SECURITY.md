# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |

## Reporting a Vulnerability

If you discover a security issue, please report it privately:

1. Email the maintainer via the contact details on [abdullaharean.com](https://abdullaharean.com), or
2. Open a **private** security advisory on GitHub if the repository is published there.

Please do not open public issues for undisclosed vulnerabilities.

## Scope

Web2API reverse-engineers unofficial web interfaces for Perplexity, ChatGPT, and Gemini. Security concerns in this project include:

- **Session cookies and auth files** — treat `*.local.json` and environment variables as secrets.
- **REST server exposure** — set `WEB2API_API_KEY` before exposing `web2api-serve` to a network.
- **Provider-side changes** — upstream web APIs may change without notice; this is not an official integration.

## Best Practices

- Never commit `auth/*.local.json` or `.env` files.
- Rotate cookies immediately if they are exposed.
- Run the REST server behind a reverse proxy with TLS in production.
- Restrict network access to the server and auth directory.

## Out of Scope

- Vulnerabilities in third-party provider websites or official APIs.
- Abuse of provider terms of service by end users.
