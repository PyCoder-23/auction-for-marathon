export function collectRoundPayload(form) {
  return {
    itemName: form.itemName.value.trim(),
    minBid: Number(form.minBid.value),
    description: form.description.value.trim(),
    squadAffiliation: form.squadAffiliation.value.trim() || null,
    xpStats: form.xpStats.value.trim() || null,
    contributionInfo: form.contributionInfo.value.trim() || null,
    imageUrl: form.imageUrl.value.trim() || null,
  };
}

export function resetRoundForm(form) {
  form.reset();
}
