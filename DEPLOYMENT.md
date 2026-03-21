# Deployment Guide (Free Hosting)

To host your bot online for free with high uptime, Follow these steps.

## Option 1: Koyeb (Recommended)
Koyeb is great for Docker containers and is more stable than Render's free tier.

1.  **Create a GitHub Repository**:
    -   Create a new private repository on GitHub.
    -   Upload all your files **EXCEPT** `node_modules`, `yt-dlp.exe`, and `auth_info_baileys`.
2.  **Deploy on Koyeb**:
    -   Link your GitHub account to [Koyeb](https://www.koyeb.com/).
    -   Select your repository.
    -   Koyeb will automatically detect the `Dockerfile` and start building.
    -   Ensure the **Port** is set to `8080`.
3.  **Migration (Crucial)**:
    -   Since you are already logged in on your PC, you need to upload the `auth_info_baileys` folder to the server or re-authenticate.
    -   *Tip*: For the first run on the server, watch the logs. It will generate a NEW pairing code. Enter it on your phone just like before.

## Option 2: Render.com
1.  **Create a New Web Service** on Render.
2.  **Link your GitHub repository**.
3.  **Select Docker** as the runtime.
4.  **Health Check Protocol**: Set to `HTTP` on port `8080`.

## Important Notes
- **Binaries**: The Dockerfile automatically installs `yt-dlp` and `ffmpeg` for Linux.
- **Persistence**: Free tiers often reset their storage when the app restarts. If the bot asks you to pair again, it's because the `auth_info_baileys` folder was reset. To avoid this permanently, a paid VPS ($5/mo) is better, but this works for free tests!
