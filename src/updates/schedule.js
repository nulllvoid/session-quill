import { parseToml, stringifyToml } from '../config/toml.js';
import { configPath, quillHome } from '../lib/paths.js';
import { readTextIfExists, writeFileAtomic } from '../lib/atomic-fs.js';
import { acquireLock } from '../worker/lock.js';
import { TrackerError } from '../lib/errors.js';
import { fingerprint, normalizeScope } from './evidence.js';
export function normalizeUpdateSchedule(p={}) {
  if(typeof p.enabled!=='boolean') throw new TrackerError('request-invalid','enabled must be true or false');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time??'18:00')) throw new TrackerError('request-invalid','time must use HH:MM');
  const rawDays=p.weekdays??[0,1,2,3,4,5,6];
  const weekdays=Array.isArray(rawDays)?rawDays.map(x=>typeof x==='string'&&/^[0-6]$/.test(x)?Number(x):x):rawDays;
  if(!Array.isArray(weekdays)||!weekdays.length||weekdays.some(x=>!Number.isInteger(x)||x<0||x>6)) throw new TrackerError('request-invalid','weekdays must contain numbers 0 through 6');
  if(!['today','yesterday'].includes(p.window_kind??'today')) throw new TrackerError('request-invalid','scheduled window must be today or yesterday');
  if(p.synthesis!==undefined && typeof p.synthesis!=='boolean') throw new TrackerError('request-invalid','synthesis must be true or false');
  const max_budget_usd=p.max_budget_usd??(p.max_budget_cents!==undefined?p.max_budget_cents/100:0.25), timeout_seconds=p.timeout_seconds??120;
  if(!Number.isFinite(max_budget_usd)||max_budget_usd<=0||max_budget_usd>5) throw new TrackerError('request-invalid','budget must be greater than zero and at most $5');
  if(!Number.isInteger(timeout_seconds)||timeout_seconds<1||timeout_seconds>120) throw new TrackerError('request-invalid','timeout must be 1 to 120 seconds');
  return {enabled:p.enabled,time:p.time??'18:00',weekdays:[...new Set(weekdays)].sort(),scope:normalizeScope(p.scope),window_kind:p.window_kind??'today',synthesis:p.synthesis===true,max_budget_usd,timeout_seconds};
}
export function updateScheduleInfo(worker) {
  const text=readTextIfExists(configPath(worker.env))??'';
  const raw=worker.config.schedule?.find(s=>s.name==='daily-update');
  const settings=normalizeUpdateSchedule(raw?{...raw,scope:{project_ids:raw.project_ids??[],repo_ids:raw.repo_ids??[]},enabled:raw.enabled===true}:{enabled:false});
  return {...settings,configured:!!raw,timezone:worker.state.meta.timezone??'UTC',fingerprint:fingerprint(text),next_run:worker.scheduleInfo?.().find(s=>s.name==='daily-update')?.next_due??null};
}
export async function saveUpdateSchedule(worker,p) {
  const settings=normalizeUpdateSchedule(p);
  const lock=await acquireLock('quill-setup',quillHome(worker.env),worker.env);
  try {
    const file=configPath(worker.env), text=readTextIfExists(file)??'';
    if(fingerprint(text)!==p.expected_fingerprint) throw new TrackerError('config-conflict','configuration changed; reload schedule settings',{status:409});
    const config=text ? parseToml(text) : {};
    const [hour,minute]=settings.time.split(':').map(Number);
    const {scope,max_budget_usd,...rest}=settings;
    const item={name:'daily-update',job:'daily-update',cron:`${minute} ${hour} * * ${settings.weekdays.join(',')}`,...rest,max_budget_cents:Math.round(max_budget_usd*100),...scope};
    config.schedule=[...(config.schedule??[{name:'reconcile',job:'reconcile',every:`${worker.config.sync_interval_hours??2}h`}]).filter(s=>s.name!=='daily-update'),item];
    writeFileAtomic(file,stringifyToml(config,{preserve:text}));
    worker.config.schedule=config.schedule;
    return updateScheduleInfo(worker);
  } finally { await lock.release(); }
}
