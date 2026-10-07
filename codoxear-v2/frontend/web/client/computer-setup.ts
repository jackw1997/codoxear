export const attachCommand = (origin: string, code: string) =>
  `npm run computer -- attach --hub '${origin.replaceAll("'", "'\\''")}' --code ${code}`;
export const computerSetup = () => `<div class="connectionStack">
  <p>Run these steps on the Linux computer where your agents will work. Keep Computer running while you use Codoxear.</p>
  <section class="connectionSection"><h2>1. Install Codoxear Computer</h2>
  <p class="connectionHint">Use Node.js 22.13 or later. Download the source on your computer and extract it, or use your existing Codoxear checkout.</p>
  <a class="connectionProvider" href="/downloads/codoxear-computer-source.tar.gz" download="codoxear-computer-source.tar.gz">Download Computer source</a>
  <pre class="connectionCode">tar -xzf codoxear-computer-source.tar.gz
cd codoxear-computer
npm ci
npm run build</pre></section>
  <section class="connectionSection"><h2>2. Sign in to your agent CLI</h2>
  <p class="connectionHint">Install Codex, Pi, or Claude Code on this computer. Sign in as the same OS user that will run Codoxear. For Codex, run <code>codex login</code>. For Pi, open <code>pi</code> and use <code>/login</code>. For Claude Code, open <code>claude</code> and finish onboarding, workspace trust, and provider confirmations. Confirm the CLI can answer a message before continuing.</p></section>
  <section class="connectionSection"><h2>3. Attach to your hub</h2>
  <p class="connectionHint">From the extracted Computer folder, run the attach command on the Pair computer page. Enter your agent workspace directory when prompted.</p>
  <pre class="connectionCode">npm run computer -- attach</pre>
  <p class="connectionHint">You can also enter your hub address and 8-character code when prompted. A code is valid once, for 15 minutes. Generate a new code if it expires.</p></section>
  <section class="connectionSection"><h2>4. Start Computer</h2>
  <pre class="connectionCode">npm run computer -- start</pre>
  <p class="connectionHint">Leave it running. Your computer should show Online in Hubs &amp; computers. Create a new agent and select this Computer &amp; hub.</p>
  <p class="connectionHint">To check a problem from another terminal:</p>
  <pre class="connectionCode">npm run computer -- status
npm run computer -- doctor</pre>
  <p class="connectionHint">Computer connects out to the hub over HTTPS. You do not need to expose a local port or configure port forwarding. Provider credentials remain on your computer.</p></section>
</div>`;
