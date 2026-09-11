"use strict";
const root = document.querySelector("#root"),
  dialog = document.querySelector("#dialog");
const paths = {
  fingerprint:
    '<path d="M12 11a2 2 0 0 0-2 2c0 3-1 6-2 8m4-8c0 4-1 7-2 9m6-1c1-3 2-7 2-9a6 6 0 0 0-12 0c0 3-1 5-2 7m14-1c1-2 2-5 2-7a10 10 0 0 0-20 0m14 2c0 3-.5 6-1 8"/>',

  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="4"/>',
  photo:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  faces:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  upload:
    '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15z"/>',
  merge: '<path d="M5 21v-5c0-5 7-3 7-8V3M19 21v-5c0-5-7-3-7-8m-4-1 4-4 4 4"/>',
  disk: '<path d="M4 4h14l3 3v14H3V4zM7 4v6h10V4M7 21v-7h10v7"/>',
  logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h12"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.photo}</svg>`;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const faceName = (f) => f.name || `Face ${f.id ?? f.face_id}`;
let cleanupMap = null;
let status = {},
  signedIn = false,
  routeVersion = 0,
  uploading = false,
  uploadProgress = null,
  uploadErrors = [],
  selected = new Set(),
  currentFace = null,
  pageOffset = 0,
  search = "",
  lastStats = "",
  polling = false;
async function api(url, options = {}) {
  const headers = { "X-Requested-With": "FaceLibrary", ...options.headers };
  if (
    options.body &&
    !(options.body instanceof File) &&
    typeof options.body !== "string"
  ) {
    options.body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  let value;
  try {
    value = await res.json();
  } catch {
    throw Error("The server did not return a valid response. Try again.");
  }
  if (!res.ok) {
    if (res.status === 401 && !url.includes("/auth/")) {
      signedIn = false;
      renderLogin();
    }
    throw Error(value.error || "Something went wrong");
  }
  return value;
}
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("visible"), 4500);
}
function errorText(error) {
  return esc(error.message || error);
}
async function renderLogin() {
  cleanupMap?.(); cleanupMap = null;
  FaceCamera.close();
  dialog.close();
  root.innerHTML = `<div class="auth-page"><header class="auth-header"><a class="brand" href="#photos"><span class="brand-mark">${icon("person")}</span>face library<span class="brand-dot">.</span></a><span class="auth-private">${icon("lock")} Your photos stay on your server</span></header>
    <main class="auth-main"><section><p class="auth-eyebrow">All your photos. All your people.</p><h1>Your photos.<br><span>Every familiar face.</span></h1><p class="auth-description">Upload a few photos or take one on your device. Find the people in them, give each face a name, and bring your memories together.</p>
      <div class="auth-action"><button class="primary" id="passkey-login" disabled><span>${icon("fingerprint")} <span id="passkey-label">Loading workspace…</span></span>${icon("arrow")}</button><div id="login-error" role="alert"></div><p id="passkey-help" class="auth-help"></p></div></section>
    <section class="auth-illustration" aria-label="From photos to familiar faces"><div class="auth-demo"><p class="auth-demo-label"><span></span>One photo, every familiar face</p><div class="auth-photo">${icon("photo")}<span class="auth-face-box one">${icon("person")}</span><span class="auth-face-box two">${icon("person")}</span></div><div class="auth-people"><span>${icon("person")} A familiar face</span><span>${icon("faces")} Connected photos</span></div><div class="auth-steps"><span>01 — Add photos</span><span>02 — Find faces</span><span>03 — Name people</span></div></div></section></main><footer class="auth-footer">Face Library · Your photos, connected by the people in them.</footer></div>`;
  const button = root.querySelector("#passkey-login");
  const label = root.querySelector("#passkey-label");
  const help = root.querySelector("#passkey-help");
  const errors = root.querySelector("#login-error");
  try {
    const owner = await api("/api/owner");
    const caption = owner.ownerRegistered
      ? "Sign in with passkey"
      : "Create your passkey";
    label.textContent = caption;
    help.textContent = owner.ownerRegistered
      ? "Use the passkey you registered for this workspace."
      : "Your passkey makes this workspace yours. No password needed.";
    if (!window.PublicKeyCredential || !window.isSecureContext)
      throw Error(
        "Open this page in a browser that supports passkeys over HTTPS.",
      );
    button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      label.textContent = "Waiting for your passkey…";
      errors.textContent = "";
      try {
        const result = owner.ownerRegistered
          ? await FaceAuth.signIn.passkey()
          : await FaceAuth.passkey.addPasskey({
              createSession: true,
              name: "Primary passkey",
            });
        if (result.error)
          throw Error(
            result.error.message ||
              "Passkey request was cancelled. Try again when ready.",
          );
        const session = await FaceAuth.getSession();
        if (!session.data)
          throw Error(
            "Could not open your session. Please try signing in again.",
          );
        signedIn = true;
        await render();
      } catch (error) {
        errors.innerHTML = `<p class="notice error">${errorText(error)}</p>`;
        button.disabled = false;
        label.textContent = caption;
      }
    };
  } catch (error) {
    errors.innerHTML = `<p class="notice error">${errorText(error)}</p>`;
  }
}
async function settingsPage() {
  root.querySelector("#page").innerHTML =
    `<div class="page-head"><div><p class="eyebrow">Workspace</p><h1>Settings</h1></div></div><section class="settings-section"><h2>${icon("fingerprint")} Passkeys</h2><p class="sub">Add a passkey on another device or security key so you always have a way back into your workspace.</p><button id="add-passkey">${icon("plus")} Add a passkey</button><div id="passkey-notice" role="status"></div></section><section class="settings-section"><h2>${icon("settings")} Face grouping</h2><p class="sub">Adjust how closely views must match to be grouped as the same person.</p><button id="grouping">Adjust similarity</button></section>`;
  root.querySelector("#grouping").onclick = groupingDialog;
  const button = root.querySelector("#add-passkey");
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = "Waiting for passkey…";
    const notice = root.querySelector("#passkey-notice");
    notice.textContent = "";
    try {
      const result = await FaceAuth.passkey.addPasskey({
        name: "Additional passkey",
      });
      if (result.error)
        throw Error(result.error.message || "Could not add a passkey.");
      notice.innerHTML = '<p class="sub">Passkey added.</p>';
    } catch (error) {
      notice.innerHTML = `<p class="notice error">${errorText(error)}</p>`;
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon("plus")} Add a passkey`;
    }
  };
}
function shell(active) {
  root.innerHTML = `<div class="shell"><a class="skip-link" href="#main">Skip to content</a><aside class="sidebar"><a class="brand" href="#photos"><span class="brand-mark">${icon("person")}</span>face library<span class="brand-dot">.</span></a><div class="nav-label">Workspace</div><nav class="nav" aria-label="Library sections"><a href="#photos" class="${active === "photos" ? "active" : ""}">${icon("photo")} Photos <span class="count" id="photo-count">${status.photos ?? 0}</span></a><a href="#faces" class="${active === "faces" ? "active" : ""}">${icon("faces")} Faces <span class="count" id="face-count">${status.faces ?? 0}</span></a><a href="#settings" class="${active === "settings" ? "active" : ""}">${icon("settings")} Settings</a></nav><div class="storage"><div class="label">${icon("disk")} Your library, on disk</div><span id="disk-info">${status.views ?? 0} face views · ${status.freeBytes ? (status.freeBytes / 1073741824).toFixed(1) + " GB free" : "Persistent storage"}</span></div><div class="sidebar-bottom"><span>${icon("lock")} Private workspace</span><button class="quiet small" id="logout" title="Sign out" aria-label="Sign out">${icon("logout")} Sign out</button></div></aside><main class="main" id="main" tabindex="-1"><div id="engine-notice"></div><div id="page"></div></main></div>`;
  root.querySelector(".skip-link").onclick = (event) => {
    event.preventDefault();
    root.querySelector("#main").focus();
  };
  root.querySelector("#logout").onclick = async () => {
    try {
      const result = await FaceAuth.signOut();
      if (result.error) throw Error(result.error.message);
      signedIn = false;
      renderLogin();
    } catch (e) {
      toast(e.message);
    }
  };
  updateNotice();
}
function updateNotice() {
  const photoCount = root.querySelector("#photo-count"), faceCount = root.querySelector("#face-count"), disk = root.querySelector("#disk-info");
  if (photoCount) photoCount.textContent = status.photos ?? 0;
  if (faceCount) faceCount.textContent = status.faces ?? 0;
  if (disk) disk.textContent = `${status.views ?? 0} face views · ${status.freeBytes ? (status.freeBytes / 1073741824).toFixed(1) + " GB free" : "Persistent storage"}`;
  const n = root.querySelector("#engine-notice");
  if (n)
    n.innerHTML = status.modelError
      ? `<div class="notice error" role="alert">Model setup needs attention: ${esc(status.modelError)}. Restart the app after checking its network access.</div>`
      : !status.ready
        ? '<div class="notice">Preparing face models. You can upload photos now; processing will begin when the models are ready.</div>'
        : "";
}
function progressMarkup() {
  if (!uploadProgress) return "";
  const p = uploadProgress;
  return `<div class="progress" aria-live="polite"><span>Uploading ${Math.min(p.done + 1, p.total)} of ${p.total} · ${esc(p.name || "")}</span><progress value="${p.done}" max="${p.total}"></progress></div>`;
}
function uploadStatusMarkup() {
  return `<div id="upload-progress">${progressMarkup()}</div>${uploadErrors.length ? `<div class="notice error upload-errors" role="alert"><div>${uploadErrors.map(esc).join("<br>")}</div><button class="quiet small" id="dismiss-upload-errors" aria-label="Dismiss upload errors">${icon("close")}</button></div>` : ""}`;
}
function uploadDialog() {
  if (uploading) {
    toast("Please wait for the current upload to finish.");
    return;
  }
  modal(
    `<h2>Add photos</h2><p class="sub">Choose photos from your device or take a new one.</p><section class="dropzone upload-dropzone" id="dropzone" aria-label="Upload photos"><div class="upload-intro"><span class="upload-symbol">${icon("upload")}</span><div><h3>Drop your photos here</h3><p>JPEG or PNG, up to 20 MB each.</p></div></div><div class="upload-actions"><button data-camera>${icon("camera")} Take a photo</button><button class="primary" id="choose-files">${icon("plus")} Choose photos</button></div><input id="files" type="file" accept="image/jpeg,image/png" multiple hidden></section>`,
  );
  const input = dialog.querySelector("#files"),
    drop = dialog.querySelector("#dropzone");
  dialog.querySelector("#choose-files").onclick = () => input.click();
  input.onchange = () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) {
      dialog.close();
      uploadFiles(files);
    }
  };
  dialog.querySelector("[data-camera]").onclick = () => {
    dialog.close();
    FaceCamera.open({ onPhoto: (file) => uploadFiles([file]), onError: toast });
  };
  ["dragenter", "dragover"].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
    }),
  );
  drop.ondrop = (event) => {
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length) {
      dialog.close();
      uploadFiles(files);
    }
  };
}
function attachUpload() {
  root
    .querySelectorAll("[data-upload]")
    .forEach((button) => (button.onclick = uploadDialog));
  const dismiss = root.querySelector("#dismiss-upload-errors");
  if (dismiss)
    dismiss.onclick = () => {
      uploadErrors = [];
      render({ keep: true });
    };
}
async function uploadFiles(files) {
  if (uploading) {
    toast("Please wait for the current upload to finish.");
    return;
  }
  if (!files.length) return;
  uploading = true;
  uploadErrors = [];
  uploadProgress = {
    done: 0,
    total: files.length,
    errors: [],
  };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    uploadProgress.name = f.name;
    uploadProgress.done = i;
    refreshUpload();
    try {
      if (f.size > 20 * 1024 * 1024) throw Error("exceeds 20 MB");
      if (
        !/\.(jpe?g|png)$/i.test(f.name) &&
        !["image/jpeg", "image/png"].includes(f.type)
      )
        throw Error("use JPEG or PNG");
      await api("/api/photos?name=" + encodeURIComponent(f.name), {
        method: "POST",
        body: f,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (e) {
      uploadProgress.errors.push(f.name + ": " + e.message);
    }
    uploadProgress.done = i + 1;
    refreshUpload();
  }
  uploading = false;
  uploadErrors = [...uploadProgress.errors];
  toast(
    `${files.length - uploadProgress.errors.length} photo${files.length - uploadProgress.errors.length !== 1 ? "s" : ""} uploaded`,
  );
  uploadProgress = null;
  refreshUpload();
  await render({ keep: true });
}
function refreshUpload() {
  const el = root.querySelector("#upload-progress");
  if (el) el.innerHTML = progressMarkup();
}
function empty(kind) {
  return `<section class="empty"><div class="empty-art"><span>${icon(kind === "photos" ? "photo" : "person")}</span><span>${icon(kind === "photos" ? "photo" : "person")}</span></div><h2>${kind === "photos" ? "Start with a few photos" : "Every familiar face, in one place"}</h2><p>${kind === "photos" ? "Add photos to your library. The people in them will find their own place in Faces." : "Upload photos to discover faces. Give each person a name, then explore every photo they appear in."}</p>${kind === "photos" ? `<button class="primary" data-upload>${icon("plus")} Add your first photos</button>` : '<a href="#photos"><button class="primary">Go to Photos ' + icon("arrow") + "</button></a>"}</section>`;
}
function photoCard(p) {
  return `<article class="photo-card"><a href="#photo/${p.id}" aria-label="Open ${esc(p.filename)}">${p.status === "ready" ? `<img src="/assets/photos/${p.id}/preview" alt="${esc(p.filename)}" loading="lazy">` : `<div class="placeholder">${p.status === "error" ? icon("photo") : '<span class="spinner"></span>'}<span>${p.status === "error" ? "Processing failed" : p.status === "processing" ? "Finding faces…" : "In the queue"}</span></div>`}</a><div class="photo-body"><div class="photo-title" title="${esc(p.filename)}">${esc(p.filename)}</div><div class="chips">${
    p.faces?.length
      ? p.faces
          .slice(0, 3)
          .map(
            (f) =>
              `<a class="chip" href="#face/${f.id}">${icon("person")}${esc(faceName(f))}</a>`,
          )
          .join("") +
        (p.faces.length > 3
          ? `<a class="chip" href="#photo/${p.id}">+${p.faces.length - 3}</a>`
          : "")
      : `<span class="dim">${p.status === "ready" ? "No faces detected" : p.status === "error" ? "Open photo to retry" : "Waiting for face views"}</span>`
  }</div></div></article>`;
}
function faceCard(f) {
  return `<a href="#face/${f.id}" class="face-card">${f.fixed ? `<span class="locked" title="Contains confirmed views">${icon("lock")}</span>` : ""}<img class="face-avatar" src="/assets/views/${f.cover}" alt="${esc(faceName(f))}" loading="lazy"><div class="face-name">${esc(faceName(f))}</div><div class="face-meta">${f.view_count} view${f.view_count === 1 ? "" : "s"} <span aria-hidden="true">·</span> ${f.photo_count} photo${f.photo_count === 1 ? "" : "s"}</div></a>`;
}
function pager(total, limit = 60) {
  if (total <= limit) return "";
  return `<div class="pager"><button id="prev" ${pageOffset === 0 ? "disabled" : ""}>${icon("back")} Previous</button><span>${pageOffset + 1}–${Math.min(pageOffset + limit, total)} of ${total}</span><button id="next" ${pageOffset + limit >= total ? "disabled" : ""}>Next ${icon("arrow")}</button></div>`;
}
function attachPager(limit = 60) {
  const prev = root.querySelector("#prev"),
    next = root.querySelector("#next");
  if (prev)
    prev.onclick = () => {
      pageOffset = Math.max(0, pageOffset - limit);
      render({ keep: true });
    };
  if (next)
    next.onclick = () => {
      pageOffset += limit;
      render({ keep: true });
    };
}
async function photosPage(version) {
  const data = await api("/api/photos?offset=" + pageOffset);
  if (version !== routeVersion) return;
  root.querySelector("#page").innerHTML =
    `<header class="page-head"><div><p class="eyebrow">Workspace</p><h1>Photos</h1><p class="sub">All your moments. All the people in them.</p></div><button class="primary" data-upload>${icon("plus")} Add photos</button></header>${uploadStatusMarkup()}<div class="toolbar"><strong>Your collection <span class="dim">&nbsp; ${data.total} photos</span></strong><span>${status.pending ? `${status.pending} processing` : "Newest first"}</span></div>${data.items.length ? `<div class="grid">${data.items.map(photoCard).join("")}</div>` : empty("photos")}${pager(data.total)}`;
  attachUpload();
  attachPager();
}
async function facesPage(version) {
  const data = await api(
    "/api/faces?offset=" + pageOffset + "&search=" + encodeURIComponent(search),
  );
  if (version !== routeVersion) return;
  root.querySelector("#page").innerHTML =
    `<header class="page-head"><div><p class="eyebrow">Workspace</p><h1>Faces</h1><p class="sub">A place for everyone in your photos.</p></div><div class="actions"><a href="#map" class="map-back">Embedding map</a><button id="adjust">${icon("settings")} Adjust grouping</button></div></header><div class="toolbar"><strong>${data.total} face${data.total === 1 ? "" : "s"} <span class="dim">&nbsp; ${status.views ?? 0} views in your library</span></strong><input id="search" type="search" placeholder="Find a person…" aria-label="Find a person" value="${esc(search)}"></div>${data.items.length ? `<div class="grid">${data.items.map(faceCard).join("")}</div>` : search ? '<section class="empty"><h2>No matching faces</h2><p>Try another name or face number.</p></section>' : empty("faces")}${pager(data.total)}`;
  root.querySelector("#adjust").onclick = groupingDialog;
  const input = root.querySelector("#search");
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      search = input.value;
      pageOffset = 0;
      render({ keep: true, focus: "search" });
    }, 350);
  };
  attachPager();
}
async function photoPage(id, version) {
  const p = await api("/api/photos/" + id);
  if (version !== routeVersion) return;
  root.querySelector("#page").innerHTML =
    `<div class="crumb"><a href="#photos">Photos</a>${icon("arrow")}<span>${esc(p.filename)}</span></div><header class="page-head detail-head"><div><h1>${esc(p.filename)}</h1><p class="sub">${p.views.length} face view${p.views.length === 1 ? "" : "s"} · ${(p.bytes / 1048576).toFixed(1)} MB · ${new Date(p.created).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</p></div><div class="actions"><a href="/assets/photos/${p.id}/original" download><button>${icon("upload")} Download original</button></a><button class="quiet danger" id="delete-photo">Delete</button></div></header>${p.status === "error" ? `<div class="notice error">${esc(p.error)} <button class="small" id="retry">Try again</button></div>` : ""}${p.status === "ready" ? `<div class="detail-layout"><div class="photo-stage"><div class="photo-wrap"><img src="/assets/photos/${p.id}/preview" alt="${esc(p.filename)}">${p.views.map((v) => `<a href="#face/${v.face_id}" class="face-box" style="left:${Math.max(0, v.x) * 100}%;top:${Math.max(0, v.y) * 100}%;width:${Math.min(v.w, 1 - Math.max(0, v.x)) * 100}%;height:${Math.min(v.h, 1 - Math.max(0, v.y)) * 100}%" aria-label="Open ${esc(v.name || "Face " + v.face_id)}"><span>${esc(v.name || "Face " + v.face_id)}</span></a>`).join("")}</div></div><aside><h2 class="side-title">Faces in this photo</h2><div class="people-list">${p.views.length ? p.views.map((v) => `<div class="person-row"><a href="#face/${v.face_id}"><img src="/assets/views/${v.id}" alt="Face view"></a><a href="#face/${v.face_id}" class="row-grow"><div class="person-name">${esc(v.name || "Face " + v.face_id)}</div><div class="small-link">View person ${v.manual ? "· Confirmed" : ""}</div></a><button class="quiet small correct" data-view="${v.id}" aria-label="Correct this view" title="Move or split this view">${icon("edit")}</button></div>`).join("") : '<p class="sub">No faces were detected in this photo.</p><button id="retry">Find faces again</button>'}</div></aside></div>` : p.status !== "error" ? '<div class="empty"><span class="spinner"></span><h2>Finding the familiar faces…</h2><p>This photo will appear when processing is complete.</p></div>' : ""}`;
  root.querySelector("#delete-photo").onclick = () =>
    confirmAction(
      "Delete this photo?",
      "The original, preview, and its face views will be removed from this library. Other photos and views stay in place.",
      "Delete photo",
      async () => {
        await api("/api/photos/" + id, { method: "DELETE" });
        location.hash = "photos";
      },
      true,
    );
  const retry = root.querySelector("#retry");
  if (retry)
    retry.onclick = async () => {
      try {
        await api(`/api/photos/${id}/retry`, { method: "POST" });
        render({ keep: true });
      } catch (e) {
        toast(e.message);
      }
    };
  root
    .querySelectorAll(".correct")
    .forEach((b) => (b.onclick = () => moveDialog([Number(b.dataset.view)])));
}
async function facePage(id, version) {
  const f = await api("/api/faces/" + id + "?offset=" + pageOffset);
  if (version !== routeVersion) return;
  currentFace = f;
  selected = new Set(
    [...selected].filter((id) => f.views.some((v) => v.id === id)),
  );
  const cover = f.cover;
  root.querySelector("#page").innerHTML =
    `<div class="crumb"><a href="#faces">Faces</a>${icon("arrow")}<span>${esc(faceName(f))}</span></div><header class="page-head detail-head"><div class="face-title-row">${cover ? `<img class="face-avatar" src="/assets/views/${cover}" alt="">` : ""}<div><h1>${esc(faceName(f))}</h1><p class="sub">${f.view_count} face view${f.view_count === 1 ? "" : "s"}${f.name ? " · Named & confirmed" : ""}</p></div></div><div class="actions"><a class="map-back" href="#map/${f.id}">Embedding map</a><button id="rename">${icon("edit")} ${f.name ? "Rename" : "Add a name"}</button><button id="merge">${icon("merge")} Merge face</button></div></header><div class="toolbar"><strong>Face views</strong><span>Select views to move them to another face or split them out.</span></div><div id="selection-bar"></div><div class="view-grid">${f.views.map((v) => `<article class="view-card ${selected.has(v.id) ? "selected" : ""}" data-view="${v.id}"><label><img src="/assets/views/${v.id}" alt="Face view from ${esc(v.filename)}" loading="lazy"><input type="checkbox" value="${v.id}" aria-label="Select view from ${esc(v.filename)}" ${selected.has(v.id) ? "checked" : ""}>${v.manual ? `<span class="locked" style="color:white;filter:drop-shadow(0 1px 3px #000)" title="Confirmed view">${icon("lock")}</span>` : ""}</label><a href="#photo/${v.photo_id}" title="Open ${esc(v.filename)}">${esc(v.filename)} ↗</a><button class="preview-choice quiet small" data-preview="${v.id}" ${v.id === cover ? "disabled" : ""}>${icon(v.id === cover ? "check" : "photo")} ${v.id === cover ? "Current preview" : "Use as preview"}</button></article>`).join("")}</div>${pager(f.view_count, 120)}<h2 class="section-title">Photos they appear in</h2><div class="grid">${f.photos.map((p) => photoCard({ ...p, status: "ready", faces: [{ id: f.id, name: f.name }] })).join("")}</div>`;
  root.querySelectorAll("[data-preview]").forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          await api(`/api/faces/${f.id}/cover`, {
            method: "PUT",
            body: { view_id: Number(button.dataset.preview) },
          });
          await render({ keep: true });
          toast("Face preview updated");
        } catch (error) {
          toast(error.message);
          button.disabled = false;
        }
      }),
  );
  root.querySelector("#rename").onclick = () => renameDialog(f);
  root.querySelector("#merge").onclick = () => mergeDialog(f);
  root.querySelectorAll(".view-card input").forEach(
    (box) =>
      (box.onchange = () => {
        const id = Number(box.value);
        box.checked ? selected.add(id) : selected.delete(id);
        box.closest(".view-card").classList.toggle("selected", box.checked);
        selectionBar();
      }),
  );
  selectionBar();
  attachPager(120);
}
function selectionBar() {
  const el = root.querySelector("#selection-bar");
  if (!el) return;
  el.innerHTML = selected.size
    ? `<div class="selection-bar"><span>${selected.size} view${selected.size === 1 ? "" : "s"} selected</span><div class="actions"><button id="move">Move to a face</button><button id="split">Create new face</button><button id="clear-selection" aria-label="Clear selection">${icon("close")}</button></div></div>`
    : "";
  if (!selected.size) return;
  root.querySelector("#move").onclick = () => moveDialog([...selected]);
  root.querySelector("#split").onclick = () =>
    confirmAction(
      "Create a separate face?",
      `${selected.size} selected view${selected.size === 1 ? "" : "s"} will move into a new face. This correction will be kept when you regroup.`,
      "Create face",
      async () => {
        const f = await api("/api/views/move", {
          method: "POST",
          body: { ids: [...selected], target: 0 },
        });
        selected.clear();
        location.hash = "face/" + f.id;
      },
    );
  root.querySelector("#clear-selection").onclick = () => {
    selected.clear();
    render({ keep: true });
  };
}
function modal(html) {
  dialog.innerHTML = `<button class="quiet close" aria-label="Close dialog">${icon("close")}</button>${html}<div id="dialog-error" role="alert"></div>`;
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog
    .querySelectorAll("[data-cancel]")
    .forEach((b) => (b.onclick = () => dialog.close()));
  if (!dialog.open) dialog.showModal();
}
async function modalRun(button, fn) {
  button.disabled = true;
  dialog.querySelector("#dialog-error").innerHTML = "";
  try {
    await fn();
    dialog.close();
    if (signedIn) await render({ keep: true });
  } catch (e) {
    const error = dialog.querySelector("#dialog-error");
    if (error) error.innerHTML = `<p class="notice error">${errorText(e)}</p>`;
  } finally {
    button.disabled = false;
  }
}
function confirmAction(title, text, label, action, danger = false) {
  modal(
    `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><button data-cancel>Cancel</button><button id="confirm" class="${danger ? "accent" : "primary"}">${esc(label)}</button></div>`,
  );
  dialog.querySelector("#confirm").onclick = (e) =>
    modalRun(e.currentTarget, action);
}
function renameDialog(f) {
  modal(
    `<h2>${f.name ? "Rename this face" : "Who is this?"}</h2><p>Giving a face a name confirms its current views. Automatic regrouping will keep them together.</p><form id="rename-form"><label for="person-name">Person’s name</label><input id="person-name" value="${esc(f.name)}" maxlength="120" placeholder="e.g. Alex" autocomplete="off"><div class="actions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Save name</button></div></form>`,
  );
  dialog.querySelector("#rename-form").onsubmit = (e) => {
    e.preventDefault();
    modalRun(e.target.querySelector("[type=submit]"), async () => {
      await api("/api/faces/" + f.id, {
        method: "PATCH",
        body: { name: dialog.querySelector("#person-name").value },
      });
      toast("Name saved. Current views are confirmed.");
    });
  };
  dialog.querySelector("#person-name").focus();
}
function groupingDialog() {
  modal(
    `<h2>Group similar faces</h2><p>The threshold controls how similar two face views need to be before they are grouped together.</p><div class="range-row"><input id="threshold-range" type="range" min="0" max="1" step="0.001" value="${status.threshold ?? 0.363}" aria-label="Similarity threshold"><input id="threshold-number" type="number" min="0" max="1" step="0.001" value="${status.threshold ?? 0.363}" aria-label="Exact similarity threshold"></div><div class="range-labels"><span>Looser · more matches</span><span>Stricter · fewer matches</span></div><p>Default: <strong>0.363</strong>. Higher values help separate people who look alike; lower values can reconnect missed matches.</p><p>Saving affects new uploads. Regrouping also updates existing automatic assignments. Named faces and manual corrections stay fixed.</p><div class="actions"><button id="regroup-now">Save & regroup</button><button id="save-threshold" class="primary">Save threshold</button></div>`,
  );
  const range = dialog.querySelector("#threshold-range"),
    num = dialog.querySelector("#threshold-number");
  range.oninput = () => (num.value = range.value);
  num.oninput = () => (range.value = num.value);
  async function save() {
    const n = Number(num.value);
    if (num.value === "" || !Number.isFinite(n) || n < 0 || n > 1)
      throw Error("Enter a number between 0 and 1");
    await api("/api/settings", { method: "POST", body: { threshold: n } });
  }
  dialog.querySelector("#save-threshold").onclick = (e) =>
    modalRun(e.currentTarget, async () => {
      await save();
      toast("Threshold saved for new uploads.");
    });
  dialog.querySelector("#regroup-now").onclick = (e) =>
    modalRun(e.currentTarget, async () => {
      await save();
      const result = await api("/api/regroup", { method: "POST" });
      toast(
        `Regrouped · ${result.changed} views reassigned. Confirmed views kept.`,
      );
    });
}
async function facePicker(
  title,
  description,
  exclude,
  onChoose,
  allowNew = false,
) {
  let chosen = null;
  modal(
    `<h2>${esc(title)}</h2><p>${esc(description)}</p><input type="search" id="pick-search" placeholder="Search by name or face number" aria-label="Search faces"><div class="choice-list" id="choices"><span class="spinner"></span></div><div class="actions"><button data-cancel>Cancel</button><button id="pick-confirm" class="primary" disabled>Continue</button></div>`,
  );
  let timer,
    request = 0;
  async function load() {
    const version = ++request;
    try {
      const data = await api(
        "/api/faces?search=" +
          encodeURIComponent(dialog.querySelector("#pick-search").value),
      );
      if (version !== request || !dialog.open) return;
      const list = data.items.filter((f) => f.id !== exclude);
      dialog.querySelector("#choices").innerHTML =
        (allowNew
          ? `<button class="choice" data-id="0">${icon("plus")} Create a new face</button>`
          : "") +
        list
          .map(
            (f) =>
              `<button class="choice" data-id="${f.id}"><img src="/assets/views/${f.cover}" alt="">${esc(faceName(f))}<span class="dim">${f.view_count} views</span></button>`,
          )
          .join("") +
        (!list.length
          ? "<p>No matching faces. Search another name or face number.</p>"
          : "");
      dialog.querySelectorAll(".choice").forEach(
        (b) =>
          (b.onclick = () => {
            chosen = Number(b.dataset.id);
            dialog
              .querySelectorAll(".choice")
              .forEach((el) => el.classList.toggle("selected", el === b));
            dialog.querySelector("#pick-confirm").disabled = false;
          }),
      );
    } catch (e) {
      dialog.querySelector("#choices").textContent = e.message;
    }
  }
  dialog.querySelector("#pick-search").oninput = () => {
    chosen = null;
    dialog.querySelector("#pick-confirm").disabled = true;
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  };
  dialog.querySelector("#pick-confirm").onclick = (e) =>
    modalRun(e.currentTarget, async () => {
      if (chosen === null) throw Error("Choose a face");
      await onChoose(chosen);
      selected.clear();
    });
  await load();
}
function moveDialog(ids) {
  facePicker(
    "Move face views",
    "Choose who these views belong to. You can also start a separate face. Your correction will be kept.",
    null,
    async (target) => {
      const f = await api("/api/views/move", {
        method: "POST",
        body: { ids, target },
      });
      toast("Views moved and confirmed.");
      location.hash = "face/" + f.id;
    },
    true,
  );
}
function mergeDialog(f) {
  facePicker(
    "Merge this face",
    `Choose the face that should include all views from ${faceName(f)}. The chosen face’s name will be kept.`,
    f.id,
    async (target) => {
      const result = await api("/api/faces/" + f.id + "/merge", {
        method: "POST",
        body: { target },
      });
      toast("Faces merged and confirmed.");
      location.hash = "face/" + result.id;
    },
  );
}
async function render(options = {}) {
  cleanupMap?.(); cleanupMap = null;
  const version = ++routeVersion;
  if (!signedIn) {
    renderLogin();
    return;
  }
  if (!options.keep) {
    pageOffset = 0;
    selected.clear();
    search = "";
  }
  const hash = (location.hash.slice(1) || "photos").split("/");
  try {
    status = await api("/api/status");
    if (version !== routeVersion) return;
    const type = hash[0];
    shell(
      type === "settings"
        ? "settings"
        : type === "faces" || type === "face" || type === "map"
          ? "faces"
          : "photos",
    );
    root.querySelector("#page").innerHTML =
      '<div class="page-head"><div class="skeleton" style="width:100%;height:200px"></div></div>';
    if (type === "face" && /^\d+$/.test(hash[1]))
      await facePage(hash[1], version);
    else if (type === "photo" && /^\d+$/.test(hash[1]))
      await photoPage(hash[1], version);
    else if (type === "faces") await facesPage(version);
    else if (type === "map") cleanupMap = FaceMap.mount(root.querySelector("#page"), {
      faceId: /^\d+$/.test(hash[1] || "") ? Number(hash[1]) : undefined,
      onMove: (id) => moveDialog([id]),
      onExpired: () => { signedIn = false; renderLogin(); },
    });
    else if (type === "settings") await settingsPage();
    else await photosPage(version);
    if (options.focus) {
      const el = root.querySelector("#" + options.focus);
      if (el) {
        el.focus();
        el.setSelectionRange?.(el.value.length, el.value.length);
      }
    }
    lastStats = JSON.stringify([
      status.photos,
      status.faces,
      status.views,
      status.pending,
      status.errors,
      status.ready,
    ]);
  } catch (e) {
    if (version !== routeVersion || !signedIn) return;
    const page = root.querySelector("#page");
    if (page)
      page.innerHTML = `<div class="notice error" role="alert">${errorText(e)}</div><a href="#photos"><button>Back to Photos</button></a>`;
    else toast(e.message);
  }
}
window.addEventListener("hashchange", () => render());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      dialog.close();
  }
});
setInterval(async () => {
  if (!signedIn || polling || document.hidden) return;
  polling = true;
  try {
    const s = await api("/api/status");
    const signature = JSON.stringify([
      s.photos,
      s.faces,
      s.views,
      s.pending,
      s.errors,
      s.ready,
    ]);
    status = s;
    updateNotice();
    if (
      signature !== lastStats &&
      !location.hash.startsWith("#map") &&
      !document.querySelector("dialog[open]") &&
      !uploading &&
      selected.size === 0 &&
      !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
    ) {
      lastStats = signature;
      await render({ keep: true });
    }
  } catch {
  } finally {
    polling = false;
  }
}, 2500);
(async () => {
  try {
    const session = await FaceAuth.getSession();
    signedIn = Boolean(session.data);
    await render();
  } catch (e) {
    renderLogin();
    toast(e.message);
  }
})();
