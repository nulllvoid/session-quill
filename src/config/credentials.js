// Credential settings for autonomous runs (spec §4.3, §4.4), read from the user config only
// (`prod` and `handoff` are user-only fields, so a repository's .quill.toml cannot set them):
//
//   [handoff]
//   keep_env = ["MY_SERVICE_API_KEY"]   # names exempt from the generic secret-name pass only (default [])
//   api_billing = false                 # keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
//
//   [prod.readonly]                     # read-only profiles, by absolute path, never copied
//   kubeconfig = "…"                    # (the AWS profile section alone is copied into the run)
//   aws_profile = "…"                   # + optional aws_config_file, aws_credentials_file
//   gcloud_config = "…"
//   google_application_credentials = "…"
//   azure_config_dir = "…"
//   [prod.readonly.db_env]              # env var name → value, or "env:NAME" to take an inherited one
//   [prod.readonly.argocd_env]          # same form
//
// An invalid value keeps the default and adds a warning that names the key, never the value.

import path from 'node:path';

export const READONLY_PATH_KEYS = ['kubeconfig', 'aws_profile', 'aws_config_file', 'aws_credentials_file', 'gcloud_config', 'google_application_credentials', 'azure_config_dir'];
export const READONLY_ENV_KEYS = ['db_env', 'argocd_env'];
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function credentialSettings(config = {}) {
  const warnings = [];
  const h = config && isTable(config.handoff) ? config.handoff : {};
  const ro = config && isTable(config.prod) && isTable(config.prod.readonly) ? config.prod.readonly : {};

  let keepEnv = [];
  if (h.keep_env !== undefined) {
    if (!Array.isArray(h.keep_env)) warnings.push('[handoff] keep_env must be a list of variable names; ignored');
    else {
      h.keep_env.forEach((name, i) => {
        if (typeof name === 'string' && ENV_NAME.test(name)) keepEnv.push(name);
        else warnings.push(`[handoff] keep_env[${i}] is not a variable name; ignored`);
      });
      keepEnv = [...new Set(keepEnv)];
    }
  }

  let apiBilling = false;
  if (h.api_billing !== undefined) {
    if (typeof h.api_billing === 'boolean') apiBilling = h.api_billing;
    else warnings.push('[handoff] api_billing must be true or false; using false');
  }

  const readonly = {};
  for (const key of READONLY_PATH_KEYS) {
    const v = ro[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) warnings.push(`[prod.readonly] ${key} must be a non-empty string; ignored`);
    // A relative path would resolve against the run's checkout, i.e. a file the repository controls.
    else if (key !== 'aws_profile' && !path.isAbsolute(v.trim())) warnings.push(`[prod.readonly] ${key} must be an absolute path; ignored`);
    else readonly[key] = v.trim();
  }
  for (const key of READONLY_ENV_KEYS) {
    const v = ro[key];
    if (v === undefined) continue;
    if (!isTable(v)) { warnings.push(`[prod.readonly] ${key} must be a table of variable names; ignored`); continue; }
    const table = {};
    for (const [name, value] of Object.entries(v)) {
      if (!ENV_NAME.test(name)) warnings.push(`[prod.readonly.${key}] an entry is not a variable name; ignored`);
      else if (typeof value !== 'string') warnings.push(`[prod.readonly.${key}] ${name} must be a string; ignored`);
      else table[name] = value;
    }
    if (Object.keys(table).length) readonly[key] = table;
  }
  return { readonly, keepEnv, apiBilling, warnings };
}
