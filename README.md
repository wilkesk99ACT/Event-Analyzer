# CEV Trip Analyzer

A self-contained, browser-only tool for analyzing SEL relay CEV event files. No server,
no build step, no dependencies to install — it's a single HTML file that runs entirely
in the browser. That also makes it trivial to host for free on GitHub Pages.

## Deploying this (step by step, no GitHub experience required)

### 1. Create a repository
1. Go to https://github.com and log in (or create a free account).
2. Click the **+** icon in the top-right corner → **New repository**.
3. Give it a name (e.g. `cev-trip-analyzer`).
4. Set it to **Public** (required for free GitHub Pages).
5. Leave everything else as default and click **Create repository**.

### 2. Upload the files
1. On your new (empty) repository's page, click **uploading an existing file**
   (or **Add file → Upload files** if you don't see that link).
2. Drag in both files from this folder:
   - `index.html`
   - `.nojekyll`
3. Scroll down and click **Commit changes**.

   > Note: `.nojekyll` has no name before the dot and no visible content — that's
   > correct. Some file pickers hide it since it's a "hidden" file type; if it doesn't
   > show up when dragging from a folder, you can also create it directly on GitHub:
   > **Add file → Create new file**, name it `.nojekyll`, leave it empty, and commit.

### 3. Turn on GitHub Pages
1. In your repository, click **Settings** (top menu).
2. In the left sidebar, click **Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Under **Branch**, select **main** and folder **/ (root)**, then click **Save**.
5. Wait 30–60 seconds, then refresh the page. A green box will appear with your live
   URL, something like:
   `https://your-username.github.io/cev-trip-analyzer/`

That's it — that URL is now the live tool. Anyone with the link can open it and drop in
CEV files; nothing is installed or uploaded to a server, since all parsing happens in
the visitor's own browser.

## Updating it later

Whenever you want to push a new version of the tool:
1. Go to the repository on GitHub and open `index.html`.
2. Click the pencil (✏️) icon to edit, or use **Add file → Upload files** to replace it
   with a new version.
3. Commit the change — GitHub Pages will redeploy automatically within about a minute.
