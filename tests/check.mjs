import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const dataPaths = ["data/common.js", "data/models/n70.js", "data/catalog.js"];
const dataScript = (
  await Promise.all(
    dataPaths.map((path) =>
      readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");
const script = await readFile(new URL("../app.js", import.meta.url), "utf8");
const localScripts = Array.from(
  html.matchAll(/<script src="\.\/([^"]+)"/g),
  (match) => match[1],
);
assert.deepEqual(
  localScripts,
  [...dataPaths, "app.js"],
  "Data files load in dependency order",
);
new vm.Script(dataScript);
new vm.Script(script);
assert.ok(!/<script[^>]*type="module"/.test(html), "No build or module loader");
assert.ok(
  !script.includes("import.meta") && !script.includes("import('./pdf')"),
  "No bundler dependencies",
);
const prefix = script.slice(0, script.indexOf("const root ="));
const context = vm.createContext({ Blob, btoa, console, structuredClone });
vm.runInContext(
  `${dataScript}\n${prefix}\nglobalThis.check = { allItems, categories, models, checklistFor, freshInspection, restoreInspection, progress, buildReportDefinition };`,
  context,
);
const {
  allItems,
  categories,
  freshInspection,
  progress,
  buildReportDefinition,
} = context.check;
assert.equal(allItems.length, 121);
assert.equal(new Set(allItems.map((item) => item.id)).size, 121);
assert.deepEqual(
  Array.from(categories, (category) => category.items.length),
  [7, 12, 10, 7, 15, 16, 21, 5, 8, 20],
);
const original = await readFile(
  new URL("../table.md", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
for (const item of allItems) {
  if (original && item.id !== "c3-i10") {
    assert.ok(original.includes(`${item.title} ${item.check} □`), item.title);
  }
  assert.ok(item.howTo.length > 15, `${item.title} has instructions`);
}
assert.equal(allItems.find((item) => item.id === "c3-i9").title, "后视镜功能");
const roofGlass = allItems.find((item) => item.id === "c3-i10");
assert.equal(roofGlass.title, "车顶玻璃（如配置）");
assert.ok(roofGlass.howTo.includes("固定式全景天幕"));
assert.ok(roofGlass.howTo.includes("不适用"));
assert.ok(roofGlass.howTo.includes("不要踩座椅、车门槛或爬上车顶"));
for (const id of ["c5-i1", "c5-i2", "c5-i3", "c5-i4"]) {
  assert.ok(allItems.find((item) => item.id === id).howTo.includes("车门边缘"));
}
for (const id of ["c2-i4", "c2-i5", "c2-i7", "c3-i8", "c4-i4"]) {
  assert.match(allItems.find((item) => item.id === id).howTo, /易[磕剐]/);
}
const glassDate = allItems.find((item) => item.id === "c3-i4").howTo;
assert.ok(glassDate.includes("仅当厂家确认"));
assert.ok(glassDate.includes("••8（左边 2 个点）→ 7 - 2 = 5，即 2018 年 5 月"));
assert.ok(
  glassDate.includes("8•••（右边 3 个点）→ 13 - 3 = 10，即 2018 年 10 月"),
);
assert.ok(glassDate.includes("假设数字 8 已确认代表 2018 年"));
assert.ok(glassDate.includes("点数为 1–6 个"));
assert.ok(glassDate.includes("不能按上述算例计算"));
const tireDate = allItems.find((item) => item.id === "c4-i3").howTo;
assert.ok(tireDate.includes("WWYY"));
assert.ok(tireDate.includes("2326 → 2026 年第 23 周"));
assert.ok(tireDate.includes("0526 → 2026 年第 5 周"));
assert.ok(tireDate.includes("不自行拆轮或钻车底"));
assert.ok(html.includes("white-space: pre-line"));
const inspection = freshInspection();
assert.equal(inspection.records[roofGlass.id].status, "pending");
inspection.records["c3-i4"] = { status: "issue", note: "玻璃日期需要确认" };
assert.equal(progress(inspection.records).issue, 1);
const report = await buildReportDefinition({ inspection, photos: [] });
const content = JSON.stringify(report);
for (const item of allItems) assert.ok(content.includes(item.title));
assert.ok(content.includes("玻璃日期需要确认"));
assert.ok(content.includes("未检查"));
for (const record of Object.values(inspection.records)) record.status = "na";
assert.equal(progress(inspection.records).applicable, 0);
assert.equal(progress(inspection.records).percent, 0);
JSON.parse(
  await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"),
);
new vm.Script(await readFile(new URL("../sw.js", import.meta.url), "utf8"));
assert.deepEqual(
  Array.from(context.check.models, (model) => model.id),
  ["n70-pro", "n70-max"],
);
for (const model of context.check.models) {
  const items = context.check
    .checklistFor(model.id)
    .flatMap((category) => category.items);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of allItems)
    assert.ok(items.some((active) => active.id === item.id));
  assert.equal(
    items.some((item) => item.id === "n70-air-height"),
    model.id === "n70-max",
  );
  const current = freshInspection(model.id);
  assert.equal(Object.keys(current.records).length, items.length);
  current.records["inactive-test"] = { status: "issue", note: "inactive" };
  assert.equal(progress(current.records, items).issue, 0);
  current.records["n70-powertrain"] = { status: "issue", note: "核对电池版本" };
  const modelReport = JSON.stringify(
    await buildReportDefinition({ inspection: current, photos: [] }),
  );
  assert.ok(modelReport.includes(model.name));
  assert.ok(modelReport.includes(model.battery));
  assert.ok(modelReport.includes("核对电池版本"));
  assert.equal(modelReport.includes("空气悬架高度调节"), model.air);
  for (const forbidden of ["N90", "第三排", "升降顶舱", "地暖", "投影仪"])
    assert.ok(!modelReport.includes(forbidden));
  for (const record of Object.values(current.records)) record.status = "na";
  assert.equal(progress(current.records, items).applicable, 0);
}
assert.equal(
  context.check.checklistFor("unknown").flatMap((category) => category.items)
    .length,
  121,
);
const isolated = context.check.checklistFor("n70-pro");
isolated[0].items[0].title = "changed";
assert.notEqual(
  context.check.checklistFor("n70-max")[0].items[0].title,
  "changed",
);
assert.notEqual(categories[0].items[0].title, "changed");
assert.equal(
  context.check.checklistFor("n70-pro")[6].items[4].title,
  "天幕遮阳帘",
);
const legacy = freshInspection();
delete legacy.modelId;
legacy.vehicle = "旧车辆备注";
legacy.records["c1-i1"] = { status: "issue", note: "保留旧备注" };
const restored = context.check.restoreInspection(legacy);
assert.equal(restored.modelId, "");
assert.equal(restored.vehicle, legacy.vehicle);
assert.equal(restored.records["c1-i1"].note, "保留旧备注");
assert.ok(!("modelId" in legacy), "Restoration does not mutate legacy input");
const incomplete = { ...legacy, modelId: "n70-max" };
assert.equal(
  context.check.restoreInspection(incomplete).records["n70-air-height"].status,
  "pending",
);
assert.equal(
  context.check.restoreInspection({ ...legacy, modelId: "unknown" }).modelId,
  "",
);
assert.throws(
  () => context.check.restoreInspection({ ...legacy, version: 99 }),
  /记录版本不兼容/,
);
const proWithInactivePhoto = await buildReportDefinition({
  inspection: freshInspection("n70-pro"),
  photos: [{ itemId: "n70-air-height", createdAt: "2026-10-09", blob: null }],
});
assert.ok(JSON.stringify(proWithInactivePhoto).includes("照片 0"));
assert.equal(proWithInactivePhoto.info.author, "MiCar PDI");

const futureContext = vm.createContext({});
vm.runInContext(
  dataScript.replace(
    "globalThis.MiCarData = (() => {",
    `
globalThis.MiCarFamilies.push({
  id: 'test-family', name: 'Test family',
  models: [{ id: 'test-ev', name: 'Test EV' }],
  overridesFor() { return { 'c1-i1': { appendHowTo: 'Test guidance' } }; },
  categoriesFor() { return [{ id: 'test-family', title: 'Test checks', items: [{ id: 'test-family-port', title: 'Test port', check: 'Test', howTo: 'Test' }] }]; },
});
globalThis.MiCarData = (() => {`,
  ),
  futureContext,
);
const futureItems = futureContext.MiCarData.checklistFor("test-ev").flatMap(
  (category) => category.items,
);
assert.equal(futureItems.length, 122);
assert.ok(futureItems[0].howTo.includes("Test guidance"));
assert.ok(
  !futureItems.some((item) => item.id.startsWith("n70-")),
  "Future family does not inherit N70 checks",
);

const swSource = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const swContext = vm.createContext({
  URL,
  self: {
    registration: { scope: "https://example.test/micar-pdi/" },
    addEventListener() {},
  },
});
vm.runInContext(`${swSource}\nglobalThis.assets = localAssets;`, swContext);
for (const path of localScripts)
  assert.ok(
    swContext.assets.includes(`./${path}`),
    `Offline cache includes ${path}`,
  );
for (const path of swContext.assets)
  if (path !== "./") await access(new URL(`../${path}`, import.meta.url));
assert.ok(
  !html.includes("model-image") && !script.includes("model-image"),
  "No model imagery",
);

const testRoot = {
  innerHTML: "",
  addEventListener() {},
  querySelectorAll() {
    return [];
  },
  toggleAttribute() {},
};
const flowContext = vm.createContext({
  Blob,
  btoa,
  console,
  structuredClone,
  URL,
  DOMException,
  document: {
    querySelector(selector) {
      return selector === "#app" ? testRoot : null;
    },
  },
  window: { addEventListener() {}, scrollTo() {} },
  navigator: { onLine: true },
  location: { hash: "", protocol: "file:" },
});
vm.runInContext(
  `${dataScript}\n${script.replace(/void start\(\);\s*$/, "")}\n
globalThis.flow = {
  selectModel, resetCurrentInspection, render, atomicReset: resetInspection,
  state: () => ({ inspection, photos, modelBusy, itemCount: allItems.length }),
};
inspection = freshInspection();
showError = error => { globalThis.flowError = error.message || error; };
`,
  flowContext,
);
for (const hash of ["#/", "#/report", "#/issues", "#/item/n70-air-height"]) {
  flowContext.location.hash = hash;
  flowContext.flow.render();
  assert.ok(
    testRoot.innerHTML.includes('id="model-form"'),
    `Model selection guards ${hash}`,
  );
  assert.ok(!testRoot.innerHTML.includes("bottom-nav"));
}
vm.runInContext(
  `
inspection.records['c1-i1'] = { status: 'issue', note: 'legacy note' };
photos = [{ id: 'legacy-photo', itemId: 'c1-i1' }];
saveInspection = async () => { throw new Error('save failed'); };
`,
  flowContext,
);
await flowContext.flow.selectModel("n70-pro");
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "",
  "Failed first selection retains legacy state",
);
assert.equal(flowContext.flow.state().photos.length, 1);
assert.equal(flowContext.flowError, "save failed");
vm.runInContext(
  "saveInspection = async next => { globalThis.saved = structuredClone(next); };",
  flowContext,
);
await flowContext.flow.selectModel("n70-pro");
assert.equal(flowContext.saved.modelId, "n70-pro");
assert.equal(
  flowContext.flow.state().inspection.records["c1-i1"].note,
  "legacy note",
);
assert.equal(flowContext.flow.state().photos.length, 1);
assert.equal(flowContext.flow.state().itemCount, 138);
assert.ok(
  testRoot.innerHTML.includes("N70 Pro") &&
    !testRoot.innerHTML.includes('id="model-form"'),
);
vm.runInContext("confirmAction = async () => false;", flowContext);
await flowContext.flow.selectModel("n70-max");
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "n70-pro",
  "Cancelled switch preserves selected model",
);
assert.equal(flowContext.flow.state().photos.length, 1);
vm.runInContext(
  `confirmAction = async () => true; resetInspection = async () => { throw new Error('reset failed'); };`,
  flowContext,
);
await flowContext.flow.selectModel("n70-max");
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "n70-pro",
  "Failed reset retains prior inspection",
);
assert.equal(flowContext.flow.state().photos.length, 1);
assert.equal(flowContext.flow.state().modelBusy, false);
vm.runInContext(
  `resetInspection = async modelId => freshInspection(modelId);`,
  flowContext,
);
await flowContext.flow.selectModel("n70-max");
assert.equal(flowContext.flow.state().inspection.modelId, "n70-max");
assert.equal(flowContext.flow.state().itemCount, 139);
assert.equal(flowContext.flow.state().photos.length, 0);
assert.equal(
  flowContext.flow.state().inspection.records["c1-i1"].status,
  "pending",
);
vm.runInContext("photoBusy = true;", flowContext);
await flowContext.flow.selectModel("n70-pro");
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "n70-max",
  "Photo saves block model changes",
);
vm.runInContext("photoBusy = false; exporting = true;", flowContext);
await flowContext.flow.selectModel("n70-pro");
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "n70-max",
  "Exports block model changes",
);
vm.runInContext(
  "exporting = false; confirmAction = async () => false;",
  flowContext,
);
await flowContext.flow.resetCurrentInspection();
assert.equal(
  flowContext.flow.state().inspection.modelId,
  "n70-max",
  "Cancelled clear preserves current model",
);
vm.runInContext("confirmAction = async () => true;", flowContext);
await flowContext.flow.resetCurrentInspection();
assert.equal(flowContext.flow.state().inspection.modelId, "");
assert.ok(
  testRoot.innerHTML.includes('id="model-form"'),
  "Clear returns to model selection",
);

const operations = [];
let failTransaction = false;
flowContext.testDb = {
  transaction(stores, mode) {
    operations.push({ stores: Array.from(stores), mode });
    const transaction = {
      objectStore(name) {
        return {
          put(value) {
            operations.push({
              store: name,
              operation: "put",
              modelId: value.modelId,
            });
          },
          clear() {
            operations.push({ store: name, operation: "clear" });
          },
        };
      },
    };
    queueMicrotask(() => {
      if (failTransaction) {
        transaction.error = new Error("transaction aborted");
        transaction.onabort();
      } else transaction.oncomplete();
    });
    return transaction;
  },
  close() {},
};
vm.runInContext("database = async () => globalThis.testDb;", flowContext);
assert.equal(
  (await flowContext.flow.atomicReset("n70-max")).modelId,
  "n70-max",
);
assert.deepEqual(operations, [
  { stores: ["inspections", "photos"], mode: "readwrite" },
  { store: "inspections", operation: "put", modelId: "n70-max" },
  { store: "photos", operation: "clear" },
]);
failTransaction = true;
await assert.rejects(
  flowContext.flow.atomicReset("n70-pro"),
  /transaction aborted/,
);
console.log(
  "Passed: modular scripts, 121 stable checks, N70 trims, future families, legacy migration, guarded selection/reset, atomic storage, model-aware reports and offline assets.",
);
