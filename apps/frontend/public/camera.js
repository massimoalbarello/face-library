"use strict";
// Camera capture stays on the device until the owner chooses Use photo.
// The native camera picker remains a separate input so regular uploads keep multi-select.
window.FaceCamera = (() => {
  const nativeInput = document.createElement("input");
  nativeInput.id = "camera-file";
  nativeInput.type = "file";
  nativeInput.accept = "image/*";
  nativeInput.setAttribute("capture", "environment");
  nativeInput.hidden = true;
  document.body.append(nativeInput);

  let active = null;
  let receivePhoto = null;
  let reportError = null;
  function mobileDevice() {
    return (
      navigator.userAgentData?.mobile ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }
  function stopStream(state) {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (state.video) state.video.srcObject = null;
  }
  function close() {
    const state = active;
    if (!state) return;
    active = null;
    stopStream(state);
    if (state.previewURL) URL.revokeObjectURL(state.previewURL);
    state.dialog.close();
    state.dialog.remove();
  }
  function jpegBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(Error("Could not capture this photo. Please try again.")),
        "image/jpeg",
        0.92,
      ),
    );
  }
  function filename() {
    return "camera-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
  }
  async function normalizeCameraFile(file) {
    if (
      file.type === "image/jpeg" ||
      file.type === "image/png" ||
      /\.(jpe?g|png)$/i.test(file.name)
    )
      return file;
    // Some native cameras return a format the server cannot decode; convert on the device.
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      const scale = Math.min(
        1,
        4096 / Math.max(image.naturalWidth, image.naturalHeight),
      );
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas
        .getContext("2d")
        .drawImage(image, 0, 0, canvas.width, canvas.height);
      return new File([await jpegBlob(canvas)], filename(), {
        type: "image/jpeg",
      });
    } catch {
      throw Error(
        "This camera format could not be opened. Please take a JPEG photo or choose a JPEG or PNG from your device.",
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  nativeInput.addEventListener("change", async () => {
    const file = nativeInput.files?.[0];
    nativeInput.value = ""; // Taking another photo, even with the same name, must fire change.
    if (!file) return;
    try {
      await receivePhoto?.(await normalizeCameraFile(file));
    } catch (error) {
      reportError?.(error.message);
    }
  });

  function showError(state, error) {
    if (active !== state) return;
    stopStream(state);
    state.capture.disabled = true;
    state.message.textContent =
      error.name === "NotAllowedError" || error.name === "SecurityError"
        ? "Camera access was not allowed. Allow it in your browser settings, then try again, or choose a photo."
        : error.name === "NotFoundError" ||
            error.name === "DevicesNotFoundError"
          ? "No camera was found on this device. Connect a camera and try again, or choose a photo."
          : "The camera could not start. It may be in use by another app. Try again, or choose a photo.";
    state.message.className = "notice error";
    state.dialog.querySelector("#camera-retry").hidden = false;
  }
  async function startPreview(state) {
    stopStream(state);
    state.file = null;
    state.preview.hidden = true;
    if (state.previewURL) URL.revokeObjectURL(state.previewURL);
    state.previewURL = null;
    state.video.hidden = false;
    state.capture.hidden = false;
    state.capture.disabled = true;
    state.dialog.querySelector("#camera-use").hidden = true;
    state.dialog.querySelector("#camera-retake").hidden = true;
    state.dialog.querySelector("#camera-retry").hidden = true;
    state.message.className = "sub";
    state.message.textContent = "Allow camera access to see a preview.";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1920 },
        },
      });
      // Permission can be answered after the dialog was cancelled.
      if (active !== state) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      state.stream = stream;
      state.video.srcObject = stream;
      await state.video.play();
      if (active !== state) return;
      if (!state.video.videoWidth) {
        await new Promise((resolve) =>
          state.video.addEventListener("loadeddata", resolve, { once: true }),
        );
      }
      if (active !== state) return;
      state.capture.disabled = false;
      state.message.textContent = "Frame your photo, then capture it.";
    } catch (error) {
      showError(state, error);
    }
  }
  function open({ onPhoto, onError }) {
    receivePhoto = onPhoto;
    reportError = onError;
    if (mobileDevice() || !navigator.mediaDevices?.getUserMedia) {
      nativeInput.click();
      return;
    }
    close();
    const sheet = document.createElement("dialog");
    sheet.id = "camera-dialog";
    sheet.setAttribute("aria-labelledby", "camera-title");
    sheet.innerHTML = `<button class="quiet close" aria-label="Close camera">×</button>
      <h2 id="camera-title">Take a photo</h2><p id="camera-message" class="sub" role="status"></p>
      <div class="camera-stage"><video id="camera-video" autoplay muted playsinline aria-label="Live camera preview"></video><img id="camera-preview" hidden alt="Captured photo preview"></div>
      <div class="camera-actions"><button id="camera-choose">Choose a photo</button><div class="actions">
        <button id="camera-retry" hidden>Try camera again</button><button id="camera-retake" hidden>Retake</button>
        <button id="camera-capture" class="primary" disabled>Capture</button><button id="camera-use" class="primary" hidden>Use photo</button>
      </div></div>`;
    document.body.append(sheet);
    const state = {
      dialog: sheet,
      video: sheet.querySelector("video"),
      preview: sheet.querySelector("#camera-preview"),
      message: sheet.querySelector("#camera-message"),
      capture: sheet.querySelector("#camera-capture"),
      stream: null,
      file: null,
      previewURL: null,
    };
    active = state;
    sheet.querySelector(".close").onclick = close;
    sheet.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    sheet.addEventListener("close", () => {
      if (active === state) close();
    });
    sheet.addEventListener("click", (event) => {
      const rect = sheet.getBoundingClientRect();
      if (
        event.target === sheet &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      )
        close();
    });
    sheet.querySelector("#camera-choose").onclick = () => {
      close();
      nativeInput.click();
    };
    sheet.querySelector("#camera-retry").onclick = () => startPreview(state);
    sheet.querySelector("#camera-retake").onclick = () => startPreview(state);
    state.capture.onclick = async () => {
      state.capture.disabled = true;
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(
          1,
          4096 / Math.max(state.video.videoWidth, state.video.videoHeight),
        );
        canvas.width = Math.round(state.video.videoWidth * scale);
        canvas.height = Math.round(state.video.videoHeight * scale);
        canvas
          .getContext("2d")
          .drawImage(state.video, 0, 0, canvas.width, canvas.height);
        const blob = await jpegBlob(canvas);
        if (active !== state) return;
        state.file = new File([blob], filename(), { type: "image/jpeg" });
        state.previewURL = URL.createObjectURL(blob);
        state.preview.src = state.previewURL;
        state.preview.hidden = false;
        state.video.hidden = true;
        stopStream(state);
        state.capture.hidden = true;
        sheet.querySelector("#camera-retake").hidden = false;
        sheet.querySelector("#camera-use").hidden = false;
        state.message.textContent =
          "Use this photo or retake it. It has not been uploaded yet.";
        sheet.querySelector("#camera-use").focus();
      } catch (error) {
        state.message.textContent = error.message;
        state.capture.disabled = false;
      }
    };
    sheet.querySelector("#camera-use").onclick = async () => {
      const file = state.file;
      if (!file) return;
      close();
      try {
        await onPhoto(file);
      } catch (error) {
        onError(error.message);
      }
    };
    sheet.showModal();
    startPreview(state);
  }
  window.addEventListener("pagehide", close);
  window.addEventListener("hashchange", close);
  // A camera must not continue running when the tab is left in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
  });
  return { open, close };
})();
