const { commonCategories, models, modelFor, checklistFor } =
  globalThis.MiCarData;
function vehicleLabel(inspection) {
  return (
    [modelFor(inspection.modelId)?.name, inspection.vehicle]
      .filter(Boolean)
      .join(" · ") || "未选择车型"
  );
}
let categories = commonCategories;
let allItems = categories.flatMap((category) => category.items);
const itemIds = new Set(
  models.flatMap((model) =>
    checklistFor(model.id).flatMap((category) =>
      category.items.map((item) => item.id),
    ),
  ),
);
function activateChecklist(modelId) {
  categories = checklistFor(modelId);
  allItems = categories.flatMap((category) => category.items);
}

const statusLabels = {
  pending: "未检查",
  normal: "正常",
  issue: "异常",
  na: "不适用",
};
let queue = Promise.resolve();
let pdfLibrary;

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("car-inspection-local", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("inspections", { keyPath: "id" });
      db.createObjectStore("photos", { keyPath: "id" }).createIndex(
        "itemId",
        "itemId",
      );
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("请关闭其他打开的验车页面后重试。"));
  });
}

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("保存被中止，请重试。"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("本机保存失败。"));
  });
}

function enqueue(operation) {
  const task = queue.then(operation);
  queue = task.catch(() => undefined);
  return task;
}

function freshInspection(modelId = "") {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    id: "current",
    version: 1,
    modelId: modelFor(modelId)?.id || "",
    vehicle: "",
    vin: "",
    mileage: "",
    date,
    updatedAt: today.toISOString(),
    records: Object.fromEntries(
      checklistFor(modelId)
        .flatMap((category) => category.items)
        .map((item) => [item.id, { status: "pending", note: "" }]),
    ),
  };
}

function restoreInspection(stored) {
  if (stored && stored.version !== 1)
    throw new Error("记录版本不兼容，请勿清空数据。");
  const modelId = modelFor(stored?.modelId)?.id || "";
  const defaults = freshInspection(modelId);
  return {
    ...defaults,
    ...stored,
    modelId,
    records: { ...defaults.records, ...stored?.records },
  };
}

async function loadCurrent() {
  await queue;
  const db = await database();
  try {
    const transaction = db.transaction(["inspections", "photos"], "readonly");
    const done = completed(transaction);
    const reads = Promise.all([
      resultOf(transaction.objectStore("inspections").get("current")),
      resultOf(transaction.objectStore("photos").getAll()),
    ]);
    const [[stored, photos]] = await Promise.all([reads, done]);
    const inspection = restoreInspection(stored);
    return { inspection, photos };
  } finally {
    db.close();
  }
}

function saveInspection(inspection) {
  const snapshot = structuredClone(inspection);
  return enqueue(async () => {
    const db = await database();
    try {
      snapshot.updatedAt = new Date().toISOString();
      const transaction = db.transaction("inspections", "readwrite");
      const done = completed(transaction);
      transaction.objectStore("inspections").put(snapshot);
      await done;
    } finally {
      db.close();
    }
  });
}

function savePhoto(photo) {
  if (!itemIds.has(photo.itemId))
    return Promise.reject(new Error("未知检查项"));
  return enqueue(async () => {
    const db = await database();
    try {
      const transaction = db.transaction("photos", "readwrite");
      const done = completed(transaction);
      transaction.objectStore("photos").put(photo);
      await done;
    } finally {
      db.close();
    }
  });
}

function deletePhoto(id) {
  return enqueue(async () => {
    const db = await database();
    try {
      const transaction = db.transaction("photos", "readwrite");
      const done = completed(transaction);
      transaction.objectStore("photos").delete(id);
      await done;
    } finally {
      db.close();
    }
  });
}

function resetInspection(modelId = "") {
  return enqueue(async () => {
    const db = await database();
    const inspection = freshInspection(modelId);
    try {
      const transaction = db.transaction(
        ["inspections", "photos"],
        "readwrite",
      );
      const done = completed(transaction);
      transaction.objectStore("inspections").put(inspection);
      transaction.objectStore("photos").clear();
      await done;
      return inspection;
    } finally {
      db.close();
    }
  });
}

async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}

function progress(records, items = allItems) {
  const values = items.map(
    (item) => records[item.id] || { status: "pending", note: "" },
  );
  const normal = values.filter((record) => record.status === "normal").length;
  const issue = values.filter((record) => record.status === "issue").length;
  const na = values.filter((record) => record.status === "na").length;
  const pending = values.filter((record) => record.status === "pending").length;
  const applicable = values.length - na;
  return {
    normal,
    issue,
    na,
    pending,
    applicable,
    done: normal + issue,
    percent: applicable ? Math.round(((normal + issue) / applicable) * 100) : 0,
  };
}

function paintIcons() {
  if (window.lucide)
    window.lucide.createIcons({
      attrs: { "stroke-width": 1.8, "aria-hidden": "true" },
    });
}

function loadPdfScript() {
  if (window.pdfMake) return Promise.resolve(window.pdfMake);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/pdfmake@0.2.23/build/pdfmake.min.js";
    script.crossOrigin = "anonymous";
    script.onload = () => resolve(window.pdfMake);
    script.onerror = () => {
      script.remove();
      reject(new Error("PDF 库加载失败，请联网重试。检查记录仍保留在本机。"));
    };
    document.head.append(script);
  });
}

async function loadPdfLibrary() {
  if (!pdfLibrary) {
    pdfLibrary = (async () => {
      const fontUrl =
        location.protocol === "file:"
          ? "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
          : new URL(
              "./public/fonts/NotoSansCJKsc-Regular.otf",
              location.href.split("#")[0],
            ).href;
      const [pdfMake, fontResponse] = await Promise.all([
        loadPdfScript(),
        fetch(fontUrl),
      ]);
      if (!fontResponse.ok)
        throw new Error("中文字体加载失败，请联网重新打开后再导出。");
      return { pdfMake, font: base64(await fontResponse.arrayBuffer()) };
    })().catch((error) => {
      pdfLibrary = undefined;
      throw error;
    });
  }
  return pdfLibrary;
}

function registerSW(callbacks) {
  let registration;
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then(async (registered) => {
        registration = registered;
        callbacks.onRegisteredSW?.("./sw.js", registration);
        if (registration.waiting) callbacks.onNeedRefresh?.();
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed") {
              if (navigator.serviceWorker.controller)
                callbacks.onNeedRefresh?.();
              else callbacks.onOfflineReady?.();
            }
          });
        });
        await navigator.serviceWorker.ready;
        callbacks.onOfflineReady?.();
      })
      .catch((error) => callbacks.onRegisterError?.(error));
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (registerSW.updating) location.reload();
    });
  }
  return async () => {
    if (registration?.waiting) {
      registerSW.updating = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  };
}
async function compressPhoto(file) {
  if (file.size > 40 * 1024 * 1024)
    throw new Error("照片超过40 MB，请选择较小的照片。");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(
        "无法读取这张照片。请重新拍摄，或在相册中转换为 JPEG 后选择。",
      );
    }
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("照片尺寸无效。");
    const scale = Math.min(
      1,
      2560 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理照片，请重试。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error("照片处理失败，原记录未改变。");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const colors = {
  ink: "#172d29",
  muted: "#50645e",
  accent: "#086956",
  issue: "#a32d32",
  line: "#dce5e0",
};
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}
async function buildReportDefinition(snapshot, onProgress = () => {}) {
  const { inspection, photos } = snapshot;
  const categories = checklistFor(inspection.modelId);
  const allItems = categories.flatMap((category) => category.items);
  const counts = progress(inspection.records, allItems);
  const orderedPhotos = allItems.flatMap((item) =>
    photos
      .filter((photo) => photo.itemId === item.id)
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt)),
  );
  const photoNumbers = new Map(
    orderedPhotos.map((photo, index) => [photo.id, index + 1]),
  );
  const issues = allItems.filter(
    (item) => inspection.records[item.id]?.status === "issue",
  );
  const content = [
    { text: "MiCar PDI 验车记录", style: "title" },
    { text: vehicleLabel(inspection), style: "vehicle", margin: [0, 4, 0, 18] },
    {
      columns: [
        {
          text: `检查日期：${inspection.date || "未填写"}\nVIN：${inspection.vin || "未填写"}`,
        },
        {
          text: `交付里程：${inspection.mileage ? `${inspection.mileage} km` : "未填写"}\n生成时间：${new Date().toLocaleString("zh-CN")}`,
        },
      ],
      margin: [0, 0, 0, 16],
    },
    {
      text: `正常 ${counts.normal}  ·  异常 ${counts.issue}  ·  未检查 ${counts.pending}  ·  不适用 ${counts.na}  ·  照片 ${orderedPhotos.length}`,
      color: colors.accent,
      margin: [0, 0, 0, 8],
    },
    {
      text: "此报告为交付现场的个人记录，不构成专业检测或车辆合格证明。",
      color: colors.muted,
      fontSize: 9,
      margin: [0, 0, 0, 20],
    },
    { text: "异常摘要", style: "heading" },
    issues.length
      ? {
          ul: issues.map(
            (item) =>
              `${item.title}${inspection.records[item.id].note ? `：${inspection.records[item.id].note}` : "（未填写备注）"}`,
          ),
          margin: [0, 0, 0, 16],
        }
      : {
          text: "没有标记为异常的项目。未检查项目仍需核对。",
          margin: [0, 0, 0, 16],
        },
  ];
  for (const [categoryIndex, category] of categories.entries()) {
    content.push({
      text: `${String(categoryIndex + 1).padStart(2, "0")}  ${category.title}`,
      style: "heading",
    });
    if (category.safety)
      content.push({
        text: category.safety,
        color: colors.muted,
        fontSize: 9,
        margin: [0, 0, 0, 8],
      });
    content.push({
      table: {
        headerRows: 1,
        widths: ["*", 52],
        body: [
          [
            { text: "检查项目与记录", bold: true, fillColor: "#edf3ef" },
            { text: "结果", bold: true, fillColor: "#edf3ef" },
          ],
          ...category.items.map((item) => {
            const record = inspection.records[item.id] ?? {
              status: "pending",
              note: "",
            };
            const references = orderedPhotos
              .filter((photo) => photo.itemId === item.id)
              .map((photo) => `P${photoNumbers.get(photo.id)}`)
              .join("、");
            const stack = [
              { text: item.title, bold: true },
              {
                text: item.check,
                color: colors.muted,
                fontSize: 9,
                margin: [0, 3, 0, 0],
              },
            ];
            if (record.note)
              stack.push({
                text: `备注：${record.note}`,
                margin: [0, 5, 0, 0],
              });
            if (references)
              stack.push({
                text: `照片：${references}`,
                color: colors.accent,
                fontSize: 9,
                margin: [0, 4, 0, 0],
              });
            return [
              { stack },
              {
                text: statusLabels[record.status],
                color: record.status === "issue" ? colors.issue : colors.ink,
              },
            ];
          }),
        ],
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0,
        hLineColor: () => colors.line,
        paddingTop: () => 8,
        paddingBottom: () => 8,
        paddingLeft: () => 8,
        paddingRight: () => 8,
      },
      margin: [0, 0, 0, 18],
    });
  }
  for (const [index, photo] of orderedPhotos.entries()) {
    onProgress(`正在整理照片 ${index + 1} / ${orderedPhotos.length}`);
    const item = allItems.find((candidate) => candidate.id === photo.itemId);
    const note = inspection.records[photo.itemId]?.note;
    content.push(
      {
        text: `P${index + 1}  ${item?.title ?? photo.itemId}`,
        style: "heading",
        pageBreak: "before",
      },
      {
        text: `记录时间：${new Date(photo.createdAt).toLocaleString("zh-CN")}`,
        color: colors.muted,
        fontSize: 9,
        margin: [0, 0, 0, 12],
      },
      {
        image: `data:${photo.blob.type};base64,${base64(await photo.blob.arrayBuffer())}`,
        fit: [499, 560],
        alignment: "center",
      },
    );
    if (note) content.push({ text: `备注：${note}`, margin: [0, 14, 0, 0] });
  }
  return {
    pageSize: "A4",
    pageMargins: [48, 44, 48, 44],
    defaultStyle: {
      font: "NotoSC",
      fontSize: 10,
      lineHeight: 1.25,
      color: colors.ink,
    },
    styles: {
      title: { fontSize: 28, bold: true },
      vehicle: { fontSize: 14, color: colors.muted },
      heading: { fontSize: 14, bold: true, margin: [0, 12, 0, 10] },
    },
    footer: (currentPage, pageCount) => ({
      text: `MiCar PDI  ·  ${currentPage} / ${pageCount}`,
      alignment: "center",
      fontSize: 9,
      color: colors.muted,
      margin: [0, 14, 0, 0],
    }),
    info: {
      title: `${vehicleLabel(inspection)}验车记录`,
      author: "MiCar PDI",
      subject: "个人交付检查记录",
    },
    content,
  };
}
async function exportInspectionPdf(snapshot, onProgress) {
  onProgress("正在载入中文字体…");
  const { pdfMake, font } = await loadPdfLibrary();
  const definition = await buildReportDefinition(snapshot, onProgress);
  onProgress("正在生成 PDF…");
  const fonts = {
    NotoSC: {
      normal: "NotoSC.otf",
      bold: "NotoSC.otf",
      italics: "NotoSC.otf",
      bolditalics: "NotoSC.otf",
    },
  };
  const blob = await new Promise((resolve) =>
    pdfMake
      .createPdf(definition, undefined, fonts, { "NotoSC.otf": font })
      .getBlob(resolve),
  );
  const vehicle = vehicleLabel(snapshot.inspection)
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 40);
  return new File(
    [blob],
    `${vehicle}-验车记录-${snapshot.inspection.date}.pdf`,
    { type: "application/pdf" },
  );
}

const root = document.querySelector("#app");
const statusIcons = {
  pending: "circle",
  normal: "check",
  issue: "circle-alert",
  na: "minus",
};
let inspection;
let photos = [];
let filter = "all";
let search = "";
let saveRevision = 0;
let savedRevision = 0;
let saveFailed = false;
let saveTask = Promise.resolve();
let photoBusy = false;
let exporting = false;
let modelBusy = false;
let choosingModel = false;
let offlineReady = false;
let updateAvailable = false;
let listPosition = 0;
let preparedPdf;
let pdfUrl;
let photoUrls = [];
const expanded = new Set(["c1"]);
function escape(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
function icon(name, className = "") {
  return `<i data-lucide="${name}" class="${className}" aria-hidden="true"></i>`;
}
function route() {
  return location.hash.slice(1) || "/";
}
function isDirty() {
  return saveFailed || savedRevision !== saveRevision || photoBusy || modelBusy;
}
function savedLabel() {
  if (saveFailed) return "保存失败";
  if (savedRevision !== saveRevision || photoBusy || modelBusy) return "保存中";
  return "已保存至本机";
}
function updateSaved() {
  const target = document.querySelector("#saved-state");
  if (target) {
    target.textContent = savedLabel();
    target.classList.toggle("error-text", saveFailed);
  }
  const retry = document.querySelector("#retry-save");
  if (retry) retry.hidden = !saveFailed;
}
function friendlyError(error) {
  if (typeof error === "string") return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError")
    return "本机存储空间不足，尚未保存。请释放设备空间后重试，不要刷新或清除网站数据。";
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
function showError(error) {
  const area = document.querySelector("#error");
  if (area) {
    area.hidden = false;
    area.textContent = friendlyError(error);
  }
}
function persist() {
  const revision = ++saveRevision;
  inspection.updatedAt = new Date().toISOString();
  updateSaved();
  saveTask = saveInspection(inspection)
    .then(() => {
      if (revision === saveRevision) {
        savedRevision = revision;
        saveFailed = false;
        const area = document.querySelector("#error");
        if (area) area.hidden = true;
      }
      updateSaved();
    })
    .catch((error) => {
      if (revision === saveRevision) {
        saveFailed = true;
        showError(error);
      }
      updateSaved();
    });
  return saveTask;
}
function header() {
  return `<header class="app-header"><a href="#/" class="brand">${icon("car-front")}<span>MiCar PDI</span></a><div class="header-right"><span id="saved-state" role="status">${savedLabel()}</span><button id="retry-save" class="icon-button" aria-label="重试保存" title="重试保存" ${saveFailed ? "" : "hidden"}>${icon("rotate-ccw")}</button><button class="icon-button" data-action="help" aria-label="安装与数据说明" title="安装与数据说明">${icon("shield-check")}</button></div></header><div class="notice" id="connection" ${!offlineReady && navigator.onLine ? "hidden" : ""}>${icon(navigator.onLine ? "check-check" : "wifi-off")}<span>${navigator.onLine ? "离线内容已就绪" : offlineReady ? "离线中 · 可继续检查" : "离线中 · 以已缓存内容为准"}</span></div><div class="update-notice" id="update-notice" ${updateAvailable ? "" : "hidden"}><span>新版本已就绪</span><button data-action="update">保存后更新</button></div><div id="error" class="error-banner" role="alert" hidden></div>`;
}
function renderModelPicker() {
  root.innerHTML = `${header()}<main class="page model-page"><span class="eyebrow">小米汽车交付检查</span><h1 tabindex="-1">选择车型</h1><form id="model-form"><fieldset class="model-choices"><legend>交付版本</legend>${models.map((model) => `<label class="model-choice"><input type="radio" name="modelId" value="${escape(model.id)}" required ${inspection.modelId === model.id ? "checked" : ""}><span><strong>${escape(model.name)}</strong><small>${escape(model.summary)}</small><small>${escape(model.detail)}</small></span></label>`).join("")}</fieldset>${!inspection.modelId && (photos.length || Object.values(inspection.records).some((record) => record.status !== "pending" || record.note)) ? '<p class="field-hint">已有验车记录将保留，请确认它属于所选车型。</p>' : ""}<div class="model-actions"><button class="primary-button" type="submit">${icon("arrow-right")}${inspection.modelId ? "确认车型" : "开始验车"}</button>${inspection.modelId ? '<button class="secondary-button" type="button" data-action="cancel-model">取消</button>' : ""}</div></form></main>`;
}
function installInspection(next, clearPhotos = false) {
  inspection = next;
  activateChecklist(next.modelId);
  if (clearPhotos) photos = [];
  choosingModel = false;
  saveRevision = savedRevision = 0;
  saveFailed = false;
  filter = "all";
  search = "";
  expanded.clear();
  expanded.add("c1");
  if (next.modelId) expanded.add(categories.at(-1).id);
  listPosition = 0;
  invalidatePdf();
  location.hash = "/";
  render();
  bindCategoryToggles();
  window.scrollTo(0, 0);
  document.querySelector("main h1")?.focus({ preventScroll: true });
}
function lockModelControls(locked) {
  root.toggleAttribute("aria-busy", locked);
  root
    .querySelectorAll("button,input,textarea")
    .forEach((element) => (element.disabled = locked));
  updateSaved();
}
async function selectModel(modelId) {
  if (!modelFor(modelId) || modelBusy || photoBusy || exporting) return;
  if (inspection.modelId === modelId) {
    choosingModel = false;
    render();
    bindCategoryToggles();
    document.querySelector("main h1")?.focus();
    return;
  }
  const changing = Boolean(inspection.modelId);
  modelBusy = true;
  try {
    if (
      changing &&
      !(await confirmAction(
        "更换车型并重新验车？",
        "当前车辆信息、检查状态、备注与照片会永久删除。请先取消并导出 PDF。",
        "更换并清空",
      ))
    )
      return;
    lockModelControls(true);
    await saveTask;
    const next = changing
      ? await resetInspection(modelId)
      : {
          ...inspection,
          modelId,
          records: {
            ...freshInspection(modelId).records,
            ...inspection.records,
          },
        };
    if (!changing) await saveInspection(next);
    installInspection(next, changing);
  } catch (error) {
    render();
    showError(error);
  } finally {
    modelBusy = false;
    lockModelControls(false);
  }
}
async function resetCurrentInspection() {
  if (modelBusy || photoBusy || exporting) {
    showError("请等待当前操作完成。");
    return;
  }
  modelBusy = true;
  try {
    if (
      !(await confirmAction(
        "清空并重新验车？",
        "当前车辆信息、全部状态、备注和照片会永久删除。建议先取消并保存 PDF。",
        "确认清空",
      ))
    )
      return;
    lockModelControls(true);
    await saveTask;
    installInspection(await resetInspection(), true);
  } catch (error) {
    showError(error);
  } finally {
    modelBusy = false;
    lockModelControls(false);
  }
}
function bottomNav(active) {
  return `<nav class="bottom-nav" aria-label="主导航"><a href="#/" data-nav="list" ${active === "list" ? 'aria-current="page"' : ""}>${icon("list-checks")}<span>检查清单</span></a><a href="#/issues" data-nav="issue" ${active === "issue" ? 'aria-current="page"' : ""}>${icon("circle-alert")}<span>异常记录<span class="nav-count">${progress(inspection.records).issue}</span></span></a><a href="#/report" ${active === "report" ? 'aria-current="page"' : ""}>${icon("file-text")}<span>验车报告</span></a></nav>`;
}
function metadata() {
  return `<div class="model-toolbar"><span class="eyebrow">${escape(modelFor(inspection.modelId).familyName)}</span><button class="secondary-button" data-action="choose-model">${icon("replace")}更换车型</button></div><details class="vehicle-details"><summary><div><span class="eyebrow">当前验车</span><h1 tabindex="-1">${escape(vehicleLabel(inspection))}</h1><p>${escape(inspection.date)}${inspection.mileage ? ` · ${escape(inspection.mileage)} km` : ""}</p></div><span class="edit-label">车辆信息 ${icon("chevron-down")}</span></summary><div class="vehicle-form"><label>年款与配置备注<input id="vehicle" data-meta="vehicle" maxlength="80" value="${escape(inspection.vehicle)}" placeholder="选填：年款、颜色、选装" autocomplete="off"></label><label>检查日期<input data-meta="date" type="date" value="${escape(inspection.date)}"></label><label>交付里程（km）<input data-meta="mileage" inputmode="decimal" maxlength="20" value="${escape(inspection.mileage)}" placeholder="0"></label><label>VIN（选填）<input data-meta="vin" maxlength="17" value="${escape(inspection.vin)}" placeholder="17 位车辆识别代号" autocapitalize="characters" autocomplete="off"></label></div></details>`;
}
function progressSummary() {
  const counts = progress(inspection.records);
  return `<section class="progress-section" aria-label="检查进度"><div class="progress-head"><div><span class="eyebrow">检查进度</span><p><strong>${counts.done}</strong><span> / ${counts.applicable} 项</span></p></div><span class="percentage">${counts.applicable ? `${counts.percent}<small>%</small>` : "无适用项"}</span></div><progress max="${counts.applicable || 1}" value="${counts.done}" aria-label="已检查 ${counts.done} 项"></progress><div class="progress-legends"><span class="normal">${icon("check")}正常 ${counts.normal}</span><span class="issue">${icon("circle-alert")}异常 ${counts.issue}</span><span>${icon("circle")}未检查 ${counts.pending}</span>${counts.na ? `<span>${icon("minus")}不适用 ${counts.na}</span>` : ""}</div></section>`;
}
function matches(itemId) {
  const item = allItems.find((candidate) => candidate.id === itemId);
  const record = inspection.records[item.id];
  const text = `${item.title} ${item.check} ${record.note}`;
  return (
    (filter === "all" || record.status === filter) &&
    (!search || text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  );
}
function listContent() {
  const sections = categories
    .map((category, categoryIndex) => {
      const visible = category.items.filter((item) => matches(item.id));
      if (!visible.length) return "";
      const done = category.items.filter((item) =>
        ["normal", "issue"].includes(inspection.records[item.id].status),
      ).length;
      const applicable = category.items.filter(
        (item) => inspection.records[item.id].status !== "na",
      ).length;
      return `<details class="category" data-category="${category.id}" ${expanded.has(category.id) || search || filter !== "all" ? "open" : ""}><summary><span class="category-number">${String(categoryIndex + 1).padStart(2, "0")}</span><h2>${category.short}</h2><span class="category-count">${done}/${applicable}</span>${icon("chevron-down", "expand-icon")}</summary><ul>${visible
        .map((item) => {
          const record = inspection.records[item.id];
          const photoCount = photos.filter(
            (photo) => photo.itemId === item.id,
          ).length;
          return `<li><a class="item-row" href="#/item/${item.id}"><span class="item-state ${record.status}">${icon(statusIcons[record.status])}</span><div class="item-body"><h3>${escape(item.title)}</h3><p>${escape(item.check)}</p>${record.note ? `<p class="note-preview">${escape(record.note)}</p>` : ""}</div><div class="item-trailing"><span class="status-label ${record.status}">${statusLabels[record.status]}</span>${photoCount ? `<span class="photo-count">${icon("camera")}${photoCount}</span>` : ""}${icon("chevron-right")}</div></a></li>`;
        })
        .join("")}</ul></details>`;
    })
    .join("");
  return (
    sections ||
    `<div class="empty-state">${icon(filter === "issue" ? "check-check" : "search")}<h2>${search ? "没有找到相关项目" : filter === "issue" ? "暂无异常记录" : "没有未检查项目"}</h2><p>${search ? "试试其他关键词" : filter === "issue" ? "标记为异常的项目会出现在这里" : "可以返回全部项目继续核对"}</p><button class="text-button" data-action="show-all">查看全部项目</button></div>`
  );
}
function renderList(issues = false) {
  if (issues) filter = "issue";
  root.innerHTML = `${header()}<main class="page list-page">${issues ? '<div class="page-title"><span class="eyebrow">交付现场记录</span><h1>异常记录</h1></div>' : `${metadata()}${progressSummary()}`}<section class="list-tools"><div class="segmented filters" aria-label="筛选检查项">${["all", "pending", "issue"].map((value) => `<button data-filter="${value}" aria-pressed="${filter === value}">${{ all: "全部", pending: "未检查", issue: "异常" }[value]}</button>`).join("")}</div><label class="search-box">${icon("search")}<span class="sr-only">搜索检查项目和备注</span><input id="search" type="search" placeholder="搜索项目或备注" value="${escape(search)}" autocomplete="off"></label></section><div id="checklist">${listContent()}</div></main>${bottomNav(issues ? "issue" : "list")}`;
}
function renderDetail(itemId) {
  const item = allItems.find((candidate) => candidate.id === itemId);
  if (!item) {
    location.hash = "/";
    return;
  }
  const category = categories.find((candidate) =>
    candidate.items.some((candidateItem) => candidateItem.id === itemId),
  );
  const record = inspection.records[item.id];
  const itemPhotos = photos.filter((photo) => photo.itemId === item.id);
  const index = allItems.findIndex((candidate) => candidate.id === item.id);
  root.innerHTML = `${header()}<main class="page detail-page"><a href="#/" class="back-link">${icon("arrow-left")}检查清单</a><div class="detail-heading"><span class="eyebrow">${category.short} · ${index + 1} / ${allItems.length}</span><h1 tabindex="-1">${escape(item.title)}</h1><p>${escape(item.check)}</p></div><section class="how-to"><div class="section-heading"><h2>怎么检查</h2></div><p>${escape(item.howTo)}</p>${category.safety ? `<div class="safety-note">${icon("shield-check")}<p>${escape(category.safety)}</p></div>` : ""}</section><section class="record-section"><h2 id="result-label">检查结果</h2><div class="status-options" role="group" aria-labelledby="result-label">${Object.keys(
    statusLabels,
  )
    .map(
      (status) =>
        `<button class="status-option ${status}" data-status="${status}" data-item="${item.id}" aria-pressed="${record.status === status}">${icon(statusIcons[status])}<span>${statusLabels[status]}</span></button>`,
    )
    .join(
      "",
    )}</div><label class="note-label" for="item-note">备注<span>选填</span></label><textarea id="item-note" data-item="${item.id}" rows="4" maxlength="3000" placeholder="具体位置、异常情况或待确认事项…">${escape(record.note)}</textarea><p class="character-count">${record.note.length} / 3000</p></section><section class="photo-section"><div class="section-heading"><h2>照片记录 <span class="muted-count">${itemPhotos.length}</span></h2></div><div class="photo-actions"><button class="primary-button" data-action="camera" ${photoBusy ? "disabled" : ""}>${icon("camera")}拍照</button><button class="secondary-button" data-action="album" ${photoBusy ? "disabled" : ""}>${icon("image-plus")}从相册选择</button></div><input class="sr-only" id="camera-input" aria-label="拍照记录" type="file" accept="image/*" capture="environment" data-photo-item="${item.id}" tabindex="-1"><input class="sr-only" id="album-input" aria-label="选择照片记录" type="file" accept="image/*" multiple data-photo-item="${item.id}" tabindex="-1">${
    itemPhotos.length
      ? `<ul class="photo-grid">${itemPhotos
          .map((photo, photoIndex) => {
            const url = URL.createObjectURL(photo.blob);
            photoUrls.push(url);
            return `<li><button class="photo-preview" data-preview="${photo.id}" aria-label="放大 ${escape(item.title)} 照片 ${photoIndex + 1}"><img src="${url}" alt="${escape(item.title)} 照片 ${photoIndex + 1}" loading="lazy"></button><button class="photo-delete icon-button" data-delete="${photo.id}" aria-label="删除照片 ${photoIndex + 1}" title="删除照片">${icon("trash-2")}</button></li>`;
          })
          .join("")}</ul>`
      : '<div class="photos-empty">尚未添加照片</div>'
  }<p class="field-hint">保存在本机的压缩副本。拍完请放大确认文字与细节清晰。</p></section><nav class="item-pagination" aria-label="检查项目导航">${index ? `<a href="#/item/${allItems[index - 1].id}">${icon("arrow-left")}上一项</a>` : "<span></span>"}${index < allItems.length - 1 ? `<a href="#/item/${allItems[index + 1].id}">下一项${icon("arrow-right")}</a>` : '<a href="#/report">查看报告' + icon("arrow-right") + "</a>"}</nav></main>`;
}
function renderReport() {
  const counts = progress(inspection.records);
  const photoCount = photos.filter((photo) =>
    allItems.some((item) => item.id === photo.itemId),
  ).length;
  root.innerHTML = `${header()}<main class="page report-page"><div class="page-title"><span class="eyebrow">当前验车 · ${escape(inspection.date)}</span><h1>验车报告</h1><p>${escape(vehicleLabel(inspection))}</p></div>${progressSummary()}<section class="report-stats"><div><span>异常项目</span><strong class="issue">${counts.issue}</strong></div><div><span>待检查</span><strong>${counts.pending}</strong></div><div><span>现场照片</span><strong>${photoCount}</strong></div></section><section class="report-export"><h2>导出 PDF</h2><p>包含车辆信息、全部检查结果、备注与照片。</p><button class="primary-button export-button" data-action="generate-pdf">${icon("file-text")}生成验车报告</button><p id="pdf-progress" role="status" class="field-hint"></p><div id="pdf-ready" ${preparedPdf ? "" : "hidden"}><p class="pdf-success">${icon("check-check")}PDF 已生成，保存后可随时查看</p><button class="primary-button" data-action="share-pdf">${icon("share-2")}分享或存到文件</button><a class="secondary-button" id="pdf-download" href="${pdfUrl ?? "#"}" download="${escape(preparedPdf?.name ?? "验车记录.pdf")}">${icon("download")}下载 PDF</a></div><p class="field-hint">报告在本机生成，不上传照片。PDF 为存档，不能导回编辑。</p></section><section class="storage-warning"><h2>本机记录</h2><p>已保存的记录在刷新或重开后会恢复。清除网站数据或设备回收存储可能造成丢失，验车结束请保存 PDF。</p><button class="danger-button" data-action="reset">${icon("rotate-ccw")}清空并重新验车</button></section></main>${bottomNav("report")}`;
}
function releasePhotoUrls() {
  for (const url of photoUrls) URL.revokeObjectURL(url);
  photoUrls = [];
}
function render() {
  releasePhotoUrls();
  const current = route();
  if (!modelFor(inspection.modelId) || choosingModel) renderModelPicker();
  else if (current.startsWith("/item/"))
    renderDetail(current.slice("/item/".length));
  else if (current === "/report") renderReport();
  else renderList(current === "/issues");
  paintIcons();
  updateSaved();
  if (saveFailed) showError("有更改尚未保存，请重试保存后再刷新。");
}
function dialog(title, body, actions) {
  const element = document.createElement("dialog");
  element.className = "modal";
  element.innerHTML = `<form method="dialog"><div class="modal-heading"><h2>${escape(title)}</h2><button class="icon-button" value="cancel" aria-label="关闭" title="关闭">${icon("x")}</button></div>${body}<div class="modal-actions">${actions}</div></form>`;
  const previous = document.activeElement;
  document.body.append(element);
  paintIcons();
  element.showModal();
  element.addEventListener(
    "close",
    () => {
      element.remove();
      previous?.focus();
    },
    { once: true },
  );
  return element;
}
function confirmAction(title, message, confirmText) {
  return new Promise((resolve) => {
    const element = dialog(
      title,
      `<p>${escape(message)}</p>`,
      `<button class="secondary-button" value="cancel" autofocus>取消</button><button class="danger-button" value="confirm">${escape(confirmText)}</button>`,
    );
    element.addEventListener(
      "close",
      () => resolve(element.returnValue === "confirm"),
      { once: true },
    );
  });
}
function showHelp() {
  dialog(
    "安装与数据",
    `<section class="help-section"><h3>添加到 iPhone 主屏幕</h3><p>在 Safari 打开本站，点分享，再选择“添加到主屏幕”。首次联网打开并等待“离线内容已就绪”后，可以离线使用。</p></section><section class="help-section"><h3>仅保存在本机</h3><p>状态、备注和照片自动保存到当前浏览器。请等“已保存至本机”后刷新。请勿使用无痕浏览或清除网站数据。</p><p>Safari 与主屏幕应用的数据可能不共享。建议从主屏幕开始验车，结束后导出 PDF。换域名、换设备不会自动转移记录。</p></section><section class="help-section"><h3>安全检查</h3><p>本清单不是专业检测结论。车辆保持静止；不拆盖板、不触碰高压部件、不钻车底，需要演示的项目请交付人员协助。</p></section>`,
    '<button class="primary-button" value="close">知道了</button>',
  );
  void requestPersistence();
}
async function addPhotos(input) {
  const selected = Array.from(input.files ?? []);
  const itemId = input.dataset.photoItem;
  input.value = "";
  if (!selected.length || photoBusy || exporting) return;
  photoBusy = true;
  updateSaved();
  root
    .querySelectorAll(".photo-actions button")
    .forEach((button) => (button.disabled = true));
  try {
    for (const file of selected) {
      const blob = await compressPhoto(file);
      const photo = {
        id: crypto.randomUUID(),
        itemId,
        blob,
        createdAt: new Date().toISOString(),
      };
      await savePhoto(photo);
      photos.push(photo);
    }
    invalidatePdf();
  } catch (error) {
    showError(error);
  } finally {
    photoBusy = false;
    const errorText = document.querySelector("#error")?.textContent;
    const hadError = !document.querySelector("#error")?.hidden;
    render();
    if (hadError && errorText) showError(errorText);
  }
}
function invalidatePdf() {
  preparedPdf = undefined;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = undefined;
}
async function generatePdf() {
  if (photoBusy || exporting) return;
  exporting = true;
  root.querySelectorAll("button").forEach((button) => (button.disabled = true));
  root.setAttribute("aria-busy", "true");
  const update = (text) => {
    const target = document.querySelector("#pdf-progress");
    if (target) target.textContent = text;
  };
  try {
    await persist();
    if (saveFailed || isDirty()) throw new Error("请先保存记录，再导出报告。");
    const snapshot = await loadCurrent();
    const file = await exportInspectionPdf(snapshot, update);
    invalidatePdf();
    preparedPdf = file;
    pdfUrl = URL.createObjectURL(file);
    if (route() === "/report") {
      renderReport();
      paintIcons();
      document
        .querySelector("#pdf-ready")
        ?.scrollIntoView({ block: "nearest" });
    }
  } catch (error) {
    showError(error);
    update("PDF 未生成，检查记录仍保留在本机。");
  } finally {
    exporting = false;
    root.removeAttribute("aria-busy");
    root
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = false));
  }
}
async function sharePdf() {
  if (!preparedPdf || !pdfUrl) return;
  try {
    if (navigator.canShare?.({ files: [preparedPdf] })) {
      await navigator.share({ files: [preparedPdf], title: "验车记录" });
    } else {
      document.querySelector("#pdf-download")?.click();
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      showError(error);
  }
}
const updateSW = registerSW({
  onOfflineReady() {
    offlineReady = true;
    refreshConnection();
  },
  onNeedRefresh() {
    updateAvailable = true;
    document.querySelector("#update-notice")?.removeAttribute("hidden");
  },
  onRegisteredSW(_url, registration) {
    if (registration?.active && navigator.serviceWorker.controller) {
      offlineReady = true;
      refreshConnection();
    }
  },
  onRegisterError(error) {
    console.error("Offline registration failed", error);
    showError("离线缓存尚未就绪，请联网重新打开。已保存的记录不受影响。");
  },
});
function refreshConnection() {
  const target = document.querySelector("#connection");
  if (target) {
    target.toggleAttribute("hidden", !offlineReady && navigator.onLine);
    target.innerHTML = `${icon(navigator.onLine ? "check-check" : "wifi-off")}<span>${navigator.onLine ? "离线内容已就绪" : offlineReady ? "离线中 · 可继续检查" : "离线中 · 以已缓存内容为准"}</span>`;
    paintIcons();
  }
}
root.addEventListener("input", (event) => {
  const input = event.target;
  if (exporting || modelBusy) return;
  if (input.id === "search") {
    search = input.value;
    document.querySelector("#checklist").innerHTML = listContent();
    paintIcons();
    bindCategoryToggles();
  } else if (input.dataset.meta) {
    const key = input.dataset.meta;
    inspection[key] = input.value;
    const summary = document.querySelector(".vehicle-details h1");
    if (key === "vehicle" && summary)
      summary.textContent = vehicleLabel(inspection);
    invalidatePdf();
    void persist();
  } else if (input.id === "item-note") {
    inspection.records[input.dataset.item].note = input.value;
    document.querySelector(".character-count").textContent =
      `${input.value.length} / 3000`;
    invalidatePdf();
    void persist();
  }
});
root.addEventListener("change", (event) => {
  const input = event.target;
  if (exporting || modelBusy) return;
  if (input.type === "file" && input.dataset.photoItem) void addPhotos(input);
});
root.addEventListener("submit", (event) => {
  if (event.target.id !== "model-form") return;
  event.preventDefault();
  void selectModel(new FormData(event.target).get("modelId"));
});
root.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  if (exporting || modelBusy) {
    event.preventDefault();
    return;
  }
  if (target.matches('a[href^="#/item/"]') && !route().startsWith("/item/"))
    listPosition = window.scrollY;
  if (target.dataset.nav === "list") filter = "all";
  if (target.dataset.nav === "issue") {
    filter = "issue";
    search = "";
  }
  if (target.dataset.filter) {
    filter = target.dataset.filter;
    render();
    bindCategoryToggles();
  }
  if (target.dataset.status) {
    inspection.records[target.dataset.item].status = target.dataset.status;
    root
      .querySelectorAll("[data-status]")
      .forEach((button) =>
        button.setAttribute("aria-pressed", String(button === target)),
      );
    invalidatePdf();
    void persist();
  }
  if (target.dataset.preview) {
    const photo = photos.find(
      (candidate) => candidate.id === target.dataset.preview,
    );
    const url = URL.createObjectURL(photo.blob);
    const element = dialog(
      "照片预览",
      `<div class="full-photo"><img src="${url}" alt="${escape(allItems.find((item) => item.id === photo.itemId).title)}记录照片"></div>`,
      '<button class="secondary-button" value="close">关闭</button>',
    );
    element.classList.add("photo-modal");
    element.addEventListener("close", () => URL.revokeObjectURL(url), {
      once: true,
    });
  }
  if (target.dataset.delete) {
    const id = target.dataset.delete;
    if (
      await confirmAction(
        "删除这张照片？",
        "删除后无法恢复，检查状态和备注不受影响。",
        "删除照片",
      )
    ) {
      try {
        await deletePhoto(id);
        photos = photos.filter((photo) => photo.id !== id);
        invalidatePdf();
        render();
      } catch (error) {
        showError(error);
      }
    }
  }
  switch (target.dataset.action) {
    case "choose-model":
      if (photoBusy) {
        showError("请等待照片保存完成。");
        break;
      }
      choosingModel = true;
      render();
      document.querySelector(".model-page h1")?.focus();
      break;
    case "cancel-model":
      choosingModel = false;
      location.hash = "/";
      render();
      bindCategoryToggles();
      document.querySelector('[data-action="choose-model"]')?.focus();
      break;
    case "help":
      showHelp();
      break;
    case "camera":
      document.querySelector("#camera-input").click();
      break;
    case "album":
      document.querySelector("#album-input").click();
      break;
    case "show-all":
      filter = "all";
      search = "";
      location.hash = "/";
      render();
      bindCategoryToggles();
      break;
    case "generate-pdf":
      await generatePdf();
      break;
    case "share-pdf":
      await sharePdf();
      break;
    case "update":
      await persist();
      if (isDirty()) showError("有内容尚未保存，请保存完成后更新。");
      else await updateSW(true);
      break;
    case "reset":
      await resetCurrentInspection();
      break;
  }
  if (target.id === "retry-save") void persist();
});
function bindCategoryToggles() {
  root.querySelectorAll("[data-category]").forEach((element) => {
    element.addEventListener("toggle", () => {
      if (element.open) expanded.add(element.dataset.category);
      else expanded.delete(element.dataset.category);
    });
  });
}
window.addEventListener("hashchange", () => {
  if (!inspection || modelBusy) return;
  if (exporting) {
    location.hash = "/report";
    return;
  }
  render();
  bindCategoryToggles();
  if (route().startsWith("/item/")) {
    window.scrollTo(0, 0);
    document
      .querySelector(".detail-heading h1")
      ?.focus({ preventScroll: true });
  } else if (route() === "/") {
    window.scrollTo(0, listPosition);
  } else window.scrollTo(0, 0);
});
window.addEventListener("online", refreshConnection);
window.addEventListener("offline", refreshConnection);
window.addEventListener("beforeunload", (event) => {
  if (isDirty() || exporting) event.preventDefault();
});
async function start() {
  try {
    const stored = await loadCurrent();
    inspection = stored.inspection;
    activateChecklist(inspection.modelId);
    photos = stored.photos.filter((photo) => itemIds.has(photo.itemId));
    await saveInspection(inspection);
    render();
    bindCategoryToggles();
    void requestPersistence();
  } catch (error) {
    root.innerHTML = `<main class="page startup-error"><h1>无法读取本机记录</h1><p>${escape(friendlyError(error))}</p><p>请勿清除网站数据。可以关闭无痕模式或确认设备存储空间后重试。</p><button class="primary-button" id="reload">重新打开</button></main>`;
    document
      .querySelector("#reload")
      ?.addEventListener("click", () => location.reload());
  }
}
void start();
