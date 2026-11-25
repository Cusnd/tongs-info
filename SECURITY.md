# Security Policy

## Scope

Tong's Information is a fully static web publication served via Cloudflare Workers Static Assets with zero runtime backend code. Security concerns typically involve:

- HTTP header policies in `engine/_headers` (e.g., accidental exposure of sensitive paths, header injection, or unsafe CORS/framing rules)
- Client-side DOM/XSS safety in `engine/assets/js/` or Feature interactive labs
- GitHub Actions workflow security (fork PR secret isolation, preview/release credential separation, supply-chain pinning)

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through GitHub's **Private Vulnerability Reporting** feature under this repository's **Security → Advisories → Report a vulnerability** tab (ensure Private Vulnerability Reporting is enabled in repository Settings → Code security).

Please include reproduction steps, affected file paths, and potential impact. We aim to acknowledge reports within 72 hours.
