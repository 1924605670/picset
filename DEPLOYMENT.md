# Picset Deployment

This project deploys through GitHub Actions to an Ubuntu server and runs as a `systemd` service named `picset`.

The runtime requires Node.js 24 or newer because project data is stored with Node's built-in SQLite module.

## Required GitHub Secrets

Set these repository secrets before running the workflow:

```bash
gh secret set TENCENT_HOST
gh secret set TENCENT_USER
gh secret set TENCENT_PASSWORD
```

Optional runtime environment values can be deployed to `/etc/picset.env` by base64-encoding an env file:

```bash
base64 -i .env | gh secret set PICSET_ENV_B64
```

The env file can include values such as:

```bash
VSLLM_API_KEY=...
VSLLM_API_BASE_URL=...
VSLLM_IMAGE_MODEL=gpt-image-2-chat
VSLLM_IMAGE_TOOL_MODEL=gpt-image-2
VSLLM_ENHANCE_MODEL=deepseek-v4-pro
PICSET_DATA_DIR=/opt/picset/data
```

## What The Workflow Does

- Runs `npm run check` on every push.
- Uploads the current release to `/tmp/picset-release` on the server.
- Installs or upgrades to Node.js 24 and installs `rsync` if needed.
- Syncs the release into `/opt/picset`.
- Preserves `/opt/picset/data`, where the SQLite database is stored.
- Creates or updates `/etc/systemd/system/picset.service`.
- Restarts the service on port `4173`.

## Server Commands

```bash
sudo systemctl status picset
sudo journalctl -u picset -f
```
