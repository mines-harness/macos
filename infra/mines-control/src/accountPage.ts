const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><title>Mines account</title><link rel="stylesheet" href="/account.css"><script src="/account.js" defer></script></head>
<body><main><a class="brand" href="/">mines<span>Account & devices</span></a><section class="card"><p class="eyebrow">YOUR WORK, CONNECTED</p><h1 id="heading">Welcome back.</h1><p class="intro" id="intro">Sign in to connect your Mines devices.</p><nav aria-label="Account action"><button id="login-tab" type="button" aria-pressed="true">Sign in</button><button id="signup-tab" type="button" aria-pressed="false">Create account</button></nav><form id="form"><div id="name-row" hidden><label for="name">Name</label><input id="name" name="name" autocomplete="name" maxlength="100"></div><div id="email-row"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div><div id="password-row"><label id="password-label" for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="128"><small>Use at least 12 characters.</small></div><button class="primary" id="submit" type="submit">Sign in</button></form><p id="message" role="status" aria-live="polite"></p><button class="text" id="forgot" type="button" hidden>Forgot your password?</button><div id="signed-in" hidden><p id="account-label"></p><p>Sign in with this account in the Mines app on each device, then approve the device connection.</p><button id="signout" type="button">Sign out</button></div><div id="device-approval" hidden><p id="device-account" class="intro"></p><p id="device-warning" class="device-warning">Only approve a code from a CLI you started. Never enter a code someone sent you. This signs the CLI in to your Mines account; access between devices still needs pairing approval.</p><form id="device-form"><label for="device-code">Code shown in your terminal</label><input id="device-code" name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" required aria-describedby="device-warning"><button id="review-device" type="submit">Review request</button></form><div id="device-decision" hidden><p>Mines CLI is requesting account sign-in.</p><output id="reviewed-device-code" class="device-code"></output><div class="device-actions"><button id="approve-device" type="button" class="primary">Approve CLI</button><button id="deny-device" type="button">Deny</button></div></div><button id="device-signout" type="button" class="text">Use another account</button></div></section><p class="foot">Your account connects your devices. Your conversations and provider credentials stay on your approved devices.</p></main></body></html>`;

const css = `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#eaeaf1;background:#101114;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:40px 20px}main{width:min(100%,440px)}.brand{font-size:30px;letter-spacing:-1.6px;font-weight:750;color:inherit;text-decoration:none;display:flex;justify-content:space-between;align-items:center;margin-bottom:36px}.brand span{font-size:12px;letter-spacing:0;font-weight:450;color:#9697a4}.card{padding:30px;border:1px solid #30313a;background:#1b1c22;border-radius:18px}.eyebrow{font-size:10px;letter-spacing:1.7px;color:#b6a8f3;font-weight:700}h1{font-size:28px;letter-spacing:-.7px;margin:18px 0 10px}.intro,.foot,#signed-in p{color:#aaaab8;font-size:14px;line-height:1.6}.intro{margin-bottom:24px}nav{display:flex;gap:6px;background:#121318;border-radius:9px;padding:4px;margin-bottom:24px}button,input{font:inherit}button{cursor:pointer;border:1px solid #3c3d48;background:#272832;color:inherit;border-radius:8px;padding:11px 16px}nav button{flex:1;font-size:13px;border:0;background:transparent}nav button[aria-pressed=true]{background:#363141;color:#e5dbff}label{display:block;font-size:13px;margin-bottom:8px}input{width:100%;padding:12px;background:#121318;color:inherit;border:1px solid #393a45;border-radius:8px;margin-bottom:18px}input:focus,button:focus-visible,a:focus-visible{outline:2px solid #b6a8f3;outline-offset:3px}small{display:block;margin-top:-10px;margin-bottom:22px;color:#9697a4;font-size:11px}.primary{width:100%;background:#c9b8ff;border-color:#c9b8ff;color:#201a31;font-weight:650;margin-top:4px}.text{display:block;margin:16px auto 0;padding:5px;border:0;background:transparent;color:#c8b9f3;font-size:12px}button:disabled{opacity:.6;cursor:wait}#message{font-size:13px;line-height:1.6;white-space:pre-line;margin:16px 0 0}#message:empty{display:none}.foot{font-size:11px;margin:20px 16px;text-align:center}.device-warning{font-size:13px;line-height:1.6;color:#beb4d8}.device-code{display:block;font-size:26px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,monospace;margin:18px 0}.device-actions{display:flex;gap:10px}.device-actions .primary{width:auto;flex:1;margin:0}#device-code{text-transform:uppercase;letter-spacing:2px}#device-decision{margin-top:24px;border-top:1px solid #393a45;padding-top:8px}[hidden]{display:none!important}@media(max-width:440px){body{padding:24px 16px}.card{padding:24px}.brand{margin-bottom:24px}}`;

const script = String.raw`(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId('form');
  const message = byId('message');
  const submit = byId('submit');
  const pageURL = new URL(location.href);
  const resetToken = pageURL.searchParams.get('token');
  const resetPage = location.pathname === '/reset-password';
  const devicePage = location.pathname === '/device';
  const incomingCode = (pageURL.searchParams.get('user_code') || '').slice(0, 16);
  let mode = resetPage ? 'reset' : 'login';
  let config = { emailVerificationRequired: true, passwordResetEnabled: false };
  let token = sessionStorage.getItem('mines-account-session') || '';
  let currentUser = null;
  let authRevision = 0;
  let deviceRevision = 0;
  let reviewedRequest = null;
  let decisionPending = null;
  if (resetToken || (devicePage && incomingCode)) history.replaceState(null, '', location.pathname);
  if (devicePage) {
    document.title = 'Connect Mines CLI';
    byId('device-code').value = incomingCode;
  }
  async function api(path, body, useToken = false, requestToken = token) {
    const response = await fetch('/api/auth/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit', redirect: 'error',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(useToken && requestToken ? { authorization: 'Bearer ' + requestToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.message === 'string' ? data.message : typeof data.error_description === 'string' ? data.error_description : 'This request could not be completed. Please try again.');
      error.status = response.status;
      throw error;
    }
    return { data, token: response.headers.get('set-auth-token') };
  }
  function showMode(next) {
    mode = next;
    message.textContent = '';
    byId('name-row').hidden = mode !== 'signup';
    byId('name').required = mode === 'signup';
    byId('email-row').hidden = mode === 'reset';
    byId('email').required = mode !== 'reset';
    byId('password-row').hidden = mode === 'recover';
    byId('password').required = mode !== 'recover';
    byId('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    byId('password-label').textContent = mode === 'reset' ? 'New password' : 'Password';
    byId('heading').textContent = { login: devicePage ? 'Sign in to connect your CLI.' : 'Welcome back.', signup: 'Make room for your work.', recover: 'Reset your password.', reset: 'Choose a new password.' }[mode];
    byId('intro').textContent = mode === 'signup' ? 'One account for your approved Mines devices.' : mode === 'recover' ? 'We will email you a password reset link.' : mode === 'reset' ? 'Your other sessions will be signed out.' : devicePage ? 'Sign in, review the code shown in your terminal, then choose whether to approve the CLI.' : 'Sign in to connect your Mines devices.';
    submit.textContent = { login: 'Sign in', signup: 'Create account', recover: 'Send reset link', reset: 'Update password' }[mode];
    byId('login-tab').setAttribute('aria-pressed', String(mode === 'login'));
    byId('signup-tab').setAttribute('aria-pressed', String(mode === 'signup'));
    byId('forgot').hidden = !config.passwordResetEnabled || mode !== 'login';
  }
  function invalidateDeviceReview() {
    deviceRevision += 1;
    reviewedRequest = null;
    byId('device-decision').hidden = true;
  }
  function clearAccount() {
    authRevision += 1;
    invalidateDeviceReview();
    currentUser = null;
    decisionPending = null;
    token = '';
    sessionStorage.removeItem('mines-account-session');
    byId('device-approval').hidden = true;
    byId('signed-in').hidden = true;
    byId('device-code').disabled = false;
    byId('review-device').disabled = false;
    byId('device-form').hidden = false;
    form.hidden = false;
    document.querySelector('nav').hidden = false;
  }
  function signedIn(user) {
    currentUser = user;
    form.hidden = true;
    document.querySelector('nav').hidden = true;
    byId('forgot').hidden = true;
    byId('heading').textContent = devicePage ? 'Connect Mines CLI.' : 'You are signed in.';
    byId('intro').textContent = devicePage ? 'Match the code with your terminal before approving.' : 'Your Mines account is ready.';
    byId('signed-in').hidden = devicePage;
    byId('account-label').textContent = user.email;
    if (devicePage) {
      byId('device-approval').hidden = false;
      byId('device-account').textContent = 'Account: ' + user.email;
    }
  }
  byId('login-tab').onclick = () => showMode('login');
  byId('signup-tab').onclick = () => showMode('signup');
  byId('forgot').onclick = () => showMode('recover');
  async function signOut() {
    const previousToken = token;
    clearAccount();
    showMode('login');
    const revision = authRevision;
    try { if (previousToken) await api('sign-out', {}, true, previousToken); }
    catch { if (revision === authRevision) message.textContent = 'You are signed out here. The account service could not revoke the session; reconnect before authorizing a CLI.'; }
  }
  byId('signout').onclick = signOut;
  byId('device-signout').onclick = signOut;
  byId('device-code').oninput = () => { invalidateDeviceReview(); message.textContent = ''; };
  byId('device-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!currentUser || decisionPending) return;
    invalidateDeviceReview();
    const revision = deviceRevision;
    const accountRevision = authRevision;
    const accountId = currentUser.id;
    const code = byId('device-code').value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) {
      message.textContent = 'Enter the eight-character code shown by your Mines CLI.';
      return;
    }
    byId('review-device').disabled = true;
    message.textContent = '';
    try {
      const result = await api('device?user_code=' + encodeURIComponent(code), undefined, true);
      if (revision !== deviceRevision || accountRevision !== authRevision || currentUser?.id !== accountId) return;
      if (result.data.client_id !== 'mines-cli') throw new Error('This request is unavailable for this account. Start a new login from your Mines CLI.');
      if (result.data.status !== 'pending') throw new Error('This code has already been processed. Start a new login from your Mines CLI.');
      reviewedRequest = { code, accountId, accountRevision };
      byId('reviewed-device-code').textContent = code.slice(0, 4) + '-' + code.slice(4);
      byId('approve-device').disabled = false;
      byId('deny-device').disabled = false;
      byId('device-decision').hidden = false;
    } catch (error) {
      if (revision !== deviceRevision || accountRevision !== authRevision) return;
      if (error.status === 401) { clearAccount(); showMode('login'); }
      message.textContent = error.message || 'This code could not be reviewed. Please try again.';
    } finally {
      if (revision === deviceRevision) byId('review-device').disabled = false;
    }
  };
  async function decideDevice(approve) {
    const request = reviewedRequest;
    if (!request || decisionPending || currentUser?.id !== request.accountId || authRevision !== request.accountRevision) return;
    const revision = deviceRevision;
    decisionPending = request;
    byId('approve-device').disabled = true;
    byId('deny-device').disabled = true;
    byId('device-code').disabled = true;
    byId('review-device').disabled = true;
    message.textContent = '';
    try {
      await api(approve ? 'device/approve' : 'device/deny', { userCode: request.code }, true);
      if (revision !== deviceRevision || authRevision !== request.accountRevision || currentUser?.id !== request.accountId) return;
      invalidateDeviceReview();
      byId('device-form').hidden = true;
      byId('heading').textContent = approve ? 'CLI sign-in approved.' : 'CLI sign-in denied.';
      byId('intro').textContent = approve ? 'Return to your terminal to finish connecting the computer.' : 'The CLI has not been signed in.';
    } catch (error) {
      if (revision !== deviceRevision || authRevision !== request.accountRevision) return;
      if (error.status === 401) { clearAccount(); showMode('login'); }
      else {
        byId('approve-device').disabled = false;
        byId('deny-device').disabled = false;
        byId('device-code').disabled = false;
        byId('review-device').disabled = false;
      }
      message.textContent = error.message || 'Your choice could not be saved. Please try again.';
    } finally { if (decisionPending === request) decisionPending = null; }
  }
  byId('approve-device').onclick = () => decideDevice(true);
  byId('deny-device').onclick = () => decideDevice(false);
  form.onsubmit = async (event) => {
    event.preventDefault(); submit.disabled = true; message.textContent = '';
    const revision = ++authRevision;
    try {
      const email = byId('email').value.trim();
      const password = byId('password').value;
      if (mode === 'recover') {
        await api('request-password-reset', { email, redirectTo: location.origin + '/reset-password' });
        if (revision === authRevision) message.textContent = 'If that account exists, a reset link has been sent. Check your inbox.';
      } else if (mode === 'reset') {
        if (!resetToken) throw new Error('Open the complete reset link from your email.');
        await api('reset-password', { token: resetToken, newPassword: password });
        if (revision !== authRevision) return;
        clearAccount(); showMode('login');
        message.textContent = 'Your password has been changed. Sign in with your new password.';
      } else {
        const result = await api(mode === 'signup' ? 'sign-up/email' : 'sign-in/email', { email, password, ...(mode === 'signup' ? { name: byId('name').value.trim() } : {}) });
        if (revision !== authRevision) return;
        byId('password').value = '';
        if (result.token) {
          token = result.token; sessionStorage.setItem('mines-account-session', token);
          const session = await api('get-session', undefined, true);
          if (revision !== authRevision) return;
          if (!session.data || (config.emailVerificationRequired && !session.data.user.emailVerified)) { clearAccount(); showMode('login'); message.textContent = 'Verify your email before signing in.'; return; }
          signedIn(session.data.user);
        } else {
          showMode('login');
          message.textContent = config.emailVerificationRequired ? 'Check your inbox and verify your email, then sign in.' : 'Your account was created. You can now sign in.';
        }
      }
    } catch (error) { if (revision === authRevision) message.textContent = error.message || 'Please try again.'; }
    finally { submit.disabled = false; }
  };
  (async () => {
    const revision = authRevision;
    try { const response = await fetch('/v1/auth-config', { credentials: 'omit', redirect: 'error' }); if (response.ok) config = await response.json(); } catch {}
    if (revision !== authRevision) return;
    showMode(mode);
    if (location.pathname === '/account-verified') message.textContent = pageURL.searchParams.has('error') ? 'This verification link could not be used. Sign in to request a new one.' : 'Email verification complete. Sign in to continue.';
    if (token && !resetPage) {
      try {
        const result = await api('get-session', undefined, true);
        if (revision !== authRevision) return;
        if (result.data && (!config.emailVerificationRequired || result.data.user.emailVerified)) signedIn(result.data.user);
        else clearAccount();
      } catch (error) { if (revision === authRevision && error.status === 401) clearAccount(); }
    }
  })();
})();`;

export const accountAssets = new Map(
  Object.entries({
    "/": { type: "text/html; charset=utf-8", body: html },
    "/account": { type: "text/html; charset=utf-8", body: html },
    "/device": { type: "text/html; charset=utf-8", body: html },
    "/reset-password": { type: "text/html; charset=utf-8", body: html },
    "/account-verified": { type: "text/html; charset=utf-8", body: html },
    "/account.css": { type: "text/css; charset=utf-8", body: css },
    "/account.js": { type: "text/javascript; charset=utf-8", body: script },
  }),
);
