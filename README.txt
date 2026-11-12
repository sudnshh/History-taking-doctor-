MedStudentsHub account registration fix

Upload server.js to the ROOT of your GitHub repository History-taking, replacing the old server.js.
Do not upload the ZIP itself.
Railway will redeploy after the commit.
No database changes or data deletions are needed.

This patch accepts POST requests from the site's real domain (including Railway-issued domains) and retains protection against cross-origin requests.
