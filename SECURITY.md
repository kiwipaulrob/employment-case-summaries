# Security Policy

## Secret Management

This repository contains **no real secrets**. All sensitive data is excluded via `.gitignore` and must be managed securely.

### Setting Secrets with Wrangler CLI

Never commit real API keys or passwords. Instead, use `wrangler secret put`:

```bash
# Set the OpenRouter API key (do not commit to Git)
wrangler secret put OPENROUTER_API_KEY

# Set the admin dashboard password
wrangler secret put ADMIN_SECRET
```

These secrets are stored **only in Cloudflare's secure vault**, not in your repository.

### Environment Variables vs. Secrets

- **Variables** (in `wrangler.jsonc`): Non-sensitive config like model name, URLs, timezone
- **Secrets** (via `wrangler secret put`): API keys, authentication tokens, admin passwords

### Files That Must Never Contain Secrets

- `.env` / `.env.local` (excluded by `.gitignore`)
- `wrangler.jsonc` (versioned control)
- Any `.ts` files (hardcoded values)
- `.env.example` (template only — placeholders only)

### If Secrets Are Accidentally Exposed

1. **Delete the commit** from the public branch (force-push if necessary)
2. **Rotate all compromised secrets immediately**:
   - Create a new OpenRouter API key at https://openrouter.ai/
   - Change the admin password to a new strong value
   - Update the secrets via `wrangler secret put`
3. **Invalidate cached credentials**: No additional action needed in Cloudflare

### Admin Password Rotation

The admin dashboard password (`ADMIN_SECRET`) should be changed periodically:

```bash
# Generate a strong random password
# e.g., using: openssl rand -base64 24

# Set the new password
wrangler secret put ADMIN_SECRET
# Paste your new password when prompted

# Deploy the worker (no code changes needed)
wrangler deploy
```

### Third-Party Services

- **OpenRouter API**: Manage at https://openrouter.ai/account/billing/keys
- **Cloudflare Email**: Secured via Cloudflare dashboard (no manual secret needed)
- **D1 Database**: Secured via service bindings (no credentials in code)

## Reporting Security Issues

If you discover a security vulnerability, please do not open a public issue. Instead:

1. Contact the project maintainer privately
2. Provide details about the vulnerability
3. Allow time for a patch before public disclosure

## Best Practices

✅ Use `wrangler secret put` for all sensitive data  
✅ Review `.gitignore` before committing  
✅ Rotate admin passwords every 90 days  
✅ Use environment-specific secrets (dev vs. production)  
✅ Store sensitive data only in Cloudflare's secure vault  

❌ Never commit `.env` files  
❌ Never paste real API keys in config files  
❌ Never share passwords in PRs or issues  
❌ Never use weak or default passwords  
