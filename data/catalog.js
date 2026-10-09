globalThis.MiCarData = (() => {
  const commonCategories = globalThis.MiCarCommon;
  const families = globalThis.MiCarFamilies || [];
  if (!commonCategories || !families.length)
    throw new Error("Checklist data must load before the catalog.");
  const models = families.flatMap((family) =>
    family.models.map((model) => ({
      ...model,
      familyId: family.id,
      familyName: family.name,
    })),
  );
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new Error("Duplicate model ID.");
  if (new Set(families.map((family) => family.id)).size !== families.length)
    throw new Error("Duplicate family ID.");

  function modelFor(modelId) {
    return models.find((model) => model.id === modelId);
  }

  function checklistFor(modelId) {
    const model = modelFor(modelId);
    const family = families.find(
      (candidate) => candidate.id === model?.familyId,
    );
    const overrides = family?.overridesFor?.(model) || {};
    const categories = commonCategories.map((category) => ({
      ...category,
      items: category.items.map((item) => {
        const { appendHowTo, ...patch } = overrides[item.id] || {};
        const resolved = { ...item, ...patch, id: item.id };
        if (appendHowTo) resolved.howTo += `\n\n${appendHowTo}`;
        return resolved;
      }),
    }));
    const additions = family?.categoriesFor?.(model) || [];
    const specificCategories = additions.map((category) => ({
      ...category,
      items: category.items.map((item) => ({ ...item })),
    }));
    const documentsIndex = categories.findIndex(
      (category) => category.id === "c10",
    );
    categories.splice(
      documentsIndex < 0 ? categories.length : documentsIndex,
      0,
      ...specificCategories,
    );
    return categories;
  }

  for (const model of models) {
    const categories = checklistFor(model.id);
    const items = categories.flatMap((category) => category.items);
    if (
      new Set(categories.map((category) => category.id)).size !==
      categories.length
    )
      throw new Error(`Duplicate category ID for ${model.id}.`);
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error(`Duplicate item ID for ${model.id}.`);
  }
  return { commonCategories, families, models, modelFor, checklistFor };
})();
