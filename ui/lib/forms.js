// Unselected deployment obligations must not block native form validation.
export function syncDeploymentSelection(input) {
  if (!input.matches?.('[data-form="deployment"] input[type="checkbox"][name^="select_"]')) return;
  const fields = input.closest('.obligation')?.querySelector('.obligation-fields');
  if (fields) fields.disabled = !input.checked;
}

export function syncStatusDeploymentChoice(input) {
 if (input.name !== 'deployment_choice') return;
 const form = input.closest('[data-form="status"]');
 if (!form) return;
 for (const group of form.querySelectorAll('[data-deployment-fields]')) {
  group.hidden = group.disabled = group.dataset.deploymentFields !== input.value;
 }
}
