import {
    Generate,
    characters,
    eventSource,
    event_types,
    isGenerating,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { selected_group } from '../../../group-chats.js';
import { ToolManager } from '../../../tool-calling.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'third-party/SillyTavern-Extension-CronJobs';
const SETTINGS_KEY = 'cronJobs';
const LEASE_KEY = 'SillyTavern_CronJobs_Leader';
const LEASE_TTL = 15_000;
const LEASE_RENEW_INTERVAL = 5_000;
const SCHEDULER_INTERVAL = 60_000;
const CRON_TOOL_NAMES = ['ListCronJobs', 'AddCronJob', 'UpdateCronJob', 'DeleteCronJob'];
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const DEFAULT_EXECUTION_TEMPLATE = `[Scheduled message from Cron Jobs]
Job: {{title}} ({{id}})
Scheduled for: {{scheduledAt}}
Current time: {{currentTime}}

This is an automated scheduled message, not a live user reply. Respond in the current chat context as you normally would.

{{prompt}}`;

const DEFAULT_TOOL_PROMPTS = {
    listDescription: 'List scheduled cron jobs for the currently open character.',
    addDescription: 'Add a scheduled cron job for the currently open character.',
    updateDescription: 'Update a scheduled cron job for the currently open character.',
    deleteDescription: 'Delete a scheduled cron job for the currently open character.',
    idDescription: 'The ID of the cron job.',
    titleDescription: 'Short human-readable title for the cron job.',
    promptDescription: 'The user message prompt to send when the cron job fires.',
    scheduleTypeDescription: 'Use "cron" for a recurring 5-field cron expression or "once" for a one-shot date/time.',
    scheduleDescription: 'For cron jobs, a 5-field cron expression. For one-shot jobs, an ISO or local date/time.',
    enabledDescription: 'Whether the cron job is enabled.',
};

const DEFAULT_SETTINGS = {
    enabled: true,
    executeOverdueOnOpen: true,
    maxOverdueAgeHours: 24,
    maxCatchupRuns: 1,
    functionToolsEnabled: true,
    executionMessageTemplate: DEFAULT_EXECUTION_TEMPLATE,
    toolPrompts: DEFAULT_TOOL_PROMPTS,
    jobs: [],
};

let schedulerTimer = null;
let leaseTimer = null;
let isCronGeneration = false;
let isRunningJobs = false;

function settings() {
    return extension_settings[SETTINGS_KEY];
}

function cloneDefault(value) {
    return structuredClone(value);
}

function ensureSettings() {
    extension_settings[SETTINGS_KEY] ||= cloneDefault(DEFAULT_SETTINGS);
    const current = settings();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) {
            current[key] = cloneDefault(value);
        }
    }
    current.toolPrompts ||= cloneDefault(DEFAULT_TOOL_PROMPTS);
    for (const [key, value] of Object.entries(DEFAULT_TOOL_PROMPTS)) {
        if (current.toolPrompts[key] === undefined) {
            current.toolPrompts[key] = value;
        }
    }
    if (!Array.isArray(current.jobs)) {
        current.jobs = [];
    }
    for (const job of current.jobs) {
        job.runHistory ||= [];
        job.enabled = job.enabled !== false;
    }
}

function getCurrentCharacter() {
    if (selected_group || this_chid === undefined || this_chid === null) {
        return null;
    }
    return characters[this_chid] || null;
}

function getCurrentCharacterJobs() {
    const character = getCurrentCharacter();
    if (!character?.avatar) {
        return [];
    }
    return settings().jobs.filter(job => job.characterAvatar === character.avatar);
}

function generateId() {
    return `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
    const date = toDate(value);
    return date ? date.toLocaleString() : 'Invalid date';
}

function parseDateSchedule(schedule) {
    const normalized = String(schedule || '').trim();
    if (!normalized) {
        throw new Error('Schedule is required.');
    }
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        throw new Error('Invalid date/time schedule.');
    }
    return date;
}

function parseCronField(field, min, max) {
    const values = new Set();
    const source = String(field || '').trim();
    if (!source) {
        throw new Error('Empty cron field.');
    }

    for (const part of source.split(',')) {
        const [rangePart, stepPart] = part.split('/');
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isInteger(step) || step < 1) {
            throw new Error(`Invalid cron step: ${part}`);
        }

        let start;
        let end;
        if (rangePart === '*') {
            start = min;
            end = max;
        } else if (rangePart.includes('-')) {
            const [rawStart, rawEnd] = rangePart.split('-').map(Number);
            start = rawStart;
            end = rawEnd;
        } else {
            start = Number(rangePart);
            end = Number(rangePart);
        }

        if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
            throw new Error(`Invalid cron range: ${part}`);
        }

        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }

    return { values, wildcard: source === '*' };
}

function parseCronExpression(expression) {
    const fields = String(expression || '').trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error('Cron schedule must have 5 fields.');
    }

    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dom: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12),
        dow: parseCronField(fields[4], 0, 7),
    };
}

function cronMatches(date, cron) {
    const dow = date.getDay();
    const domMatches = cron.dom.values.has(date.getDate());
    const dowMatches = cron.dow.values.has(dow) || (dow === 0 && cron.dow.values.has(7));
    const dayMatches = cron.dom.wildcard && cron.dow.wildcard
        ? true
        : cron.dom.wildcard
            ? dowMatches
            : cron.dow.wildcard
                ? domMatches
                : domMatches || dowMatches;

    return cron.minute.values.has(date.getMinutes())
        && cron.hour.values.has(date.getHours())
        && cron.month.values.has(date.getMonth() + 1)
        && dayMatches;
}

function getNextCronRun(expression, after = new Date()) {
    const cron = parseCronExpression(expression);
    const candidate = new Date(after);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    const maxIterations = 366 * 24 * 60;
    for (let i = 0; i < maxIterations; i++) {
        if (cronMatches(candidate, cron)) {
            return candidate;
        }
        candidate.setMinutes(candidate.getMinutes() + 1);
    }

    throw new Error('Unable to find a cron occurrence within one year.');
}

function computeNextRun(job, after = new Date()) {
    if (job.scheduleType === 'once') {
        return parseDateSchedule(job.schedule);
    }
    return getNextCronRun(job.schedule, after);
}

function validateSchedule(scheduleType, schedule) {
    const type = scheduleType === 'once' ? 'once' : 'cron';
    const nextRun = type === 'once' ? parseDateSchedule(schedule) : getNextCronRun(schedule, new Date(Date.now() - 60_000));
    return { type, nextRun };
}

function renderTemplate(template, variables) {
    return String(template).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
        return Object.hasOwn(variables, key) ? String(variables[key]) : match;
    });
}

function getToolPrompt(key) {
    return settings().toolPrompts[key] || DEFAULT_TOOL_PROMPTS[key];
}

function getLeaderLease() {
    try {
        return JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
    } catch {
        return null;
    }
}

function ownsLeaderLease() {
    const lease = getLeaderLease();
    return lease?.tabId === TAB_ID && Number(lease.expiresAt) > Date.now();
}

function getLeaderLeaseState() {
    const lease = getLeaderLease();
    const expiresAt = Number(lease?.expiresAt || 0);
    const now = Date.now();

    if (!lease || expiresAt <= now) {
        return { state: 'stale', remainingMs: 0 };
    }

    if (lease.tabId === TAB_ID) {
        return { state: 'leader', remainingMs: expiresAt - now };
    }

    return { state: 'other', remainingMs: expiresAt - now };
}

function acquireLeaderLease() {
    const lease = getLeaderLease();
    if (lease && lease.tabId !== TAB_ID && Number(lease.expiresAt) > Date.now()) {
        return false;
    }
    localStorage.setItem(LEASE_KEY, JSON.stringify({ tabId: TAB_ID, expiresAt: Date.now() + LEASE_TTL }));
    return ownsLeaderLease();
}

function renewLeaderLease() {
    if (!ownsLeaderLease()) {
        acquireLeaderLease();
    } else {
        localStorage.setItem(LEASE_KEY, JSON.stringify({ tabId: TAB_ID, expiresAt: Date.now() + LEASE_TTL }));
    }
    updateStatus();
}

function isCurrentTabLeader() {
    return ownsLeaderLease() || acquireLeaderLease();
}

function releaseLeaderLease() {
    if (ownsLeaderLease()) {
        localStorage.removeItem(LEASE_KEY);
    }
}

function getDraftText() {
    return String($('#send_textarea').val() || '');
}

function canRunNow({ ignoreRunnerLock = false } = {}) {
    return settings().enabled
        && isCurrentTabLeader()
        && !isGenerating()
        && (ignoreRunnerLock || !isRunningJobs)
        && !getDraftText().trim()
        && !!getCurrentCharacter();
}

function addRunHistory(job, status, detail = '') {
    job.runHistory ||= [];
    job.runHistory.unshift({
        at: new Date().toISOString(),
        status,
        detail,
    });
    job.runHistory = job.runHistory.slice(0, 10);
}

function advanceJob(job, fromDate) {
    if (job.scheduleType === 'once') {
        job.enabled = false;
        job.nextRunAt = null;
        return;
    }
    job.nextRunAt = computeNextRun(job, fromDate).toISOString();
}

function getDueJobs(now = new Date()) {
    const maxAgeMs = Math.max(0, Number(settings().maxOverdueAgeHours) || 0) * 60 * 60 * 1000;
    return getCurrentCharacterJobs()
        .filter(job => job.enabled !== false && job.nextRunAt)
        .map(job => ({ job, scheduledAt: toDate(job.nextRunAt) }))
        .filter(({ scheduledAt }) => scheduledAt && scheduledAt <= now)
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
        .map(({ job, scheduledAt }) => {
            const overdueAge = now.getTime() - scheduledAt.getTime();
            return { job, scheduledAt, isTooOld: overdueAge > maxAgeMs };
        });
}

function buildCronMessage(job, scheduledAt) {
    return renderTemplate(settings().executionMessageTemplate || DEFAULT_EXECUTION_TEMPLATE, {
        id: job.id,
        title: job.title,
        scheduledAt: formatDate(scheduledAt),
        currentTime: formatDate(new Date()),
        prompt: job.prompt,
    });
}

async function runJob(job, scheduledAt) {
    const message = buildCronMessage(job, scheduledAt);
    const textarea = $('#send_textarea');
    if (getDraftText().trim()) {
        throw new Error(t`User draft exists; deferring cron job.`);
    }

    job.lastRunAt = new Date().toISOString();
    job.updatedAt = job.lastRunAt;
    addRunHistory(job, 'started', `Scheduled for ${scheduledAt.toISOString()}`);
    advanceJob(job, scheduledAt);
    saveSettingsDebounced();
    renderJobs();

    isCronGeneration = true;
    try {
        textarea.val(message)[0]?.dispatchEvent(new Event('input', { bubbles: true }));
        await Generate('normal', { automatic_trigger: true });
        addRunHistory(job, 'success', `Scheduled for ${scheduledAt.toISOString()}`);
    } catch (error) {
        addRunHistory(job, 'error', error instanceof Error ? error.message : String(error));
        throw error;
    } finally {
        isCronGeneration = false;
        job.updatedAt = new Date().toISOString();
        saveSettingsDebounced();
        renderJobs();
    }
}

async function checkDueJobs(reason = 'timer') {
    if (!settings().enabled || !getCurrentCharacter()) {
        return;
    }

    if (!canRunNow()) {
        updateStatus();
        return;
    }

    isRunningJobs = true;
    try {
        const dueJobs = getDueJobs();
        let runs = 0;
        const maxRuns = Math.max(1, Number(settings().maxCatchupRuns) || 1);
        const isCatchupCheck = ['app_ready', 'chat_changed', 'manual'].includes(reason);

        for (const { job, scheduledAt, isTooOld } of dueJobs) {
            if (runs >= maxRuns || !canRunNow({ ignoreRunnerLock: true })) {
                break;
            }

            if (isCatchupCheck && !settings().executeOverdueOnOpen) {
                addRunHistory(job, 'skipped', t`Overdue execution is disabled.`);
                advanceJob(job, new Date());
                continue;
            }

            if (isTooOld) {
                addRunHistory(job, 'skipped', t`Overdue run exceeded maximum age.`);
                advanceJob(job, new Date());
                continue;
            }

            await runJob(job, scheduledAt);
            runs++;
        }
    } finally {
        isRunningJobs = false;
        saveSettingsDebounced();
        renderJobs();
        updateStatus();
    }
}

function normalizeJobInput(input = {}) {
    const title = String(input.title || '').trim();
    const prompt = String(input.prompt || '').trim();
    const schedule = String(input.schedule || '').trim();
    const scheduleType = input.scheduleType === 'once' ? 'once' : 'cron';

    if (!title) {
        throw new Error(t`Title is required.`);
    }
    if (!prompt) {
        throw new Error(t`Prompt is required.`);
    }
    const { nextRun } = validateSchedule(scheduleType, schedule);
    return { title, prompt, schedule, scheduleType, nextRun };
}

function createJob(input) {
    const character = getCurrentCharacter();
    if (!character?.avatar) {
        throw new Error(t`Open a character chat before creating cron jobs.`);
    }

    const normalized = normalizeJobInput(input);
    const now = new Date().toISOString();
    const job = {
        id: generateId(),
        characterAvatar: character.avatar,
        characterName: character.name || '',
        title: normalized.title,
        prompt: normalized.prompt,
        enabled: input.enabled !== false,
        scheduleType: normalized.scheduleType,
        schedule: normalized.schedule,
        nextRunAt: normalized.nextRun.toISOString(),
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
        runHistory: [],
    };
    settings().jobs.push(job);
    saveSettingsDebounced();
    return job;
}

function updateJob(id, input) {
    const job = getCurrentCharacterJobs().find(item => item.id === id);
    if (!job) {
        throw new Error(t`Cron job not found for the current character.`);
    }

    const nextInput = {
        title: input.title ?? job.title,
        prompt: input.prompt ?? job.prompt,
        scheduleType: input.scheduleType ?? job.scheduleType,
        schedule: input.schedule ?? job.schedule,
    };
    const normalized = normalizeJobInput(nextInput);

    job.title = normalized.title;
    job.prompt = normalized.prompt;
    job.scheduleType = normalized.scheduleType;
    job.schedule = normalized.schedule;
    job.nextRunAt = normalized.nextRun.toISOString();
    if (input.enabled !== undefined) {
        job.enabled = input.enabled !== false;
    }
    job.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    return job;
}

function deleteJob(id) {
    const character = getCurrentCharacter();
    const index = settings().jobs.findIndex(job => job.id === id && job.characterAvatar === character?.avatar);
    if (index === -1) {
        throw new Error(t`Cron job not found for the current character.`);
    }
    const [job] = settings().jobs.splice(index, 1);
    saveSettingsDebounced();
    return job;
}

function summarizeJob(job) {
    return {
        id: job.id,
        title: job.title,
        enabled: job.enabled !== false,
        scheduleType: job.scheduleType,
        schedule: job.schedule,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        prompt: job.prompt,
        recentHistory: (job.runHistory || []).slice(0, 3),
    };
}

function registerFunctionTools() {
    for (const name of CRON_TOOL_NAMES) {
        ToolManager.unregisterFunctionTool(name);
    }

    if (!settings().functionToolsEnabled) {
        return;
    }

    const shouldRegister = () => settings().functionToolsEnabled && !isCronGeneration && !!getCurrentCharacter();
    const schema = (properties, required = []) => Object.freeze({
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties,
        required,
    });

    ToolManager.registerFunctionTool({
        name: 'ListCronJobs',
        displayName: 'List Cron Jobs',
        description: getToolPrompt('listDescription'),
        parameters: schema({}),
        shouldRegister,
        action: async () => JSON.stringify(getCurrentCharacterJobs().map(summarizeJob)),
    });

    ToolManager.registerFunctionTool({
        name: 'AddCronJob',
        displayName: 'Add Cron Job',
        description: getToolPrompt('addDescription'),
        parameters: schema({
            title: { type: 'string', description: getToolPrompt('titleDescription') },
            prompt: { type: 'string', description: getToolPrompt('promptDescription') },
            scheduleType: { type: 'string', enum: ['cron', 'once'], description: getToolPrompt('scheduleTypeDescription') },
            schedule: { type: 'string', description: getToolPrompt('scheduleDescription') },
            enabled: { type: 'boolean', description: getToolPrompt('enabledDescription') },
        }, ['title', 'prompt', 'scheduleType', 'schedule']),
        shouldRegister,
        action: async (args) => {
            const job = createJob(args);
            renderJobs();
            return JSON.stringify(summarizeJob(job));
        },
    });

    ToolManager.registerFunctionTool({
        name: 'UpdateCronJob',
        displayName: 'Update Cron Job',
        description: getToolPrompt('updateDescription'),
        parameters: schema({
            id: { type: 'string', description: getToolPrompt('idDescription') },
            title: { type: 'string', description: getToolPrompt('titleDescription') },
            prompt: { type: 'string', description: getToolPrompt('promptDescription') },
            scheduleType: { type: 'string', enum: ['cron', 'once'], description: getToolPrompt('scheduleTypeDescription') },
            schedule: { type: 'string', description: getToolPrompt('scheduleDescription') },
            enabled: { type: 'boolean', description: getToolPrompt('enabledDescription') },
        }, ['id']),
        shouldRegister,
        action: async (args) => {
            const job = updateJob(String(args.id), args);
            renderJobs();
            return JSON.stringify(summarizeJob(job));
        },
    });

    ToolManager.registerFunctionTool({
        name: 'DeleteCronJob',
        displayName: 'Delete Cron Job',
        description: getToolPrompt('deleteDescription'),
        parameters: schema({
            id: { type: 'string', description: getToolPrompt('idDescription') },
        }, ['id']),
        shouldRegister,
        action: async (args) => {
            const job = deleteJob(String(args.id));
            renderJobs();
            return JSON.stringify({ deleted: summarizeJob(job) });
        },
    });
}

function setEditorJob(job = null) {
    $('#cronjobs_edit_id').val(job?.id || '');
    $('#cronjobs_edit_title').val(job?.title || '');
    $('#cronjobs_edit_schedule_type').val(job?.scheduleType || 'cron');
    $('#cronjobs_edit_schedule').val(job?.schedule || '');
    $('#cronjobs_edit_prompt').val(job?.prompt || '');
    $('#cronjobs_edit_enabled').prop('checked', job?.enabled !== false);
    $('#cronjobs_editor_title').text(job ? t`Edit cron job` : t`Add cron job`);
    $('#cronjobs_edit_validation').text('');
}

function renderJobs() {
    const list = $('#cronjobs_job_list');
    if (!list.length) {
        return;
    }

    const character = getCurrentCharacter();
    if (!character) {
        list.empty().append($('<div></div>').text(t`Open a character chat to manage cron jobs.`));
        updateStatus();
        return;
    }

    const jobs = getCurrentCharacterJobs().sort((a, b) => String(a.nextRunAt || '').localeCompare(String(b.nextRunAt || '')));
    list.empty();
    if (!jobs.length) {
        list.append($('<div></div>').text(t`No cron jobs for this character.`));
    }

    for (const job of jobs) {
        const item = $('<div></div>').addClass('cronjobs_job_item');
        const header = $('<div></div>').addClass('cronjobs_job_header');
        const title = $('<div></div>').addClass('cronjobs_job_title').text(job.title);
        const enabled = $('<label></label>').addClass('checkbox_label').append($('<span></span>').text(t`Enabled`));
        const checkbox = $('<input type="checkbox" />').prop('checked', job.enabled !== false).on('change', () => {
            job.enabled = checkbox.prop('checked');
            job.updatedAt = new Date().toISOString();
            saveSettingsDebounced();
            renderJobs();
        });
        enabled.append(checkbox);
        header.append(title, enabled);

        const meta = $('<div></div>').addClass('cronjobs_job_meta').text(`${job.scheduleType}: ${job.schedule} | ${t`next`}: ${job.nextRunAt ? formatDate(job.nextRunAt) : t`none`} | ${t`last`}: ${job.lastRunAt ? formatDate(job.lastRunAt) : t`never`}`);
        const prompt = $('<div></div>').addClass('cronjobs_job_meta').text(job.prompt);
        const actions = $('<div></div>').addClass('cronjobs_job_actions');
        actions.append($('<button></button>').addClass('menu_button').text(t`Edit`).on('click', () => setEditorJob(job)));
        actions.append($('<button></button>').addClass('menu_button').text(t`Delete`).on('click', () => {
            deleteJob(job.id);
            setEditorJob();
            renderJobs();
        }));
        item.append(header, meta, prompt, actions);
        list.append(item);
    }
    updateStatus();
}

function onCharacterRenamed(oldAvatar, newAvatar) {
    let changed = false;
    for (const job of settings().jobs) {
        if (job.characterAvatar === oldAvatar) {
            job.characterAvatar = newAvatar;
            job.updatedAt = new Date().toISOString();
            changed = true;
        }
    }
    if (changed) {
        saveSettingsDebounced();
        renderJobs();
    }
}

function onCharacterDeleted(data) {
    const avatar = data?.character?.avatar;
    if (!avatar) {
        return;
    }
    const before = settings().jobs.length;
    settings().jobs = settings().jobs.filter(job => job.characterAvatar !== avatar);
    if (settings().jobs.length !== before) {
        saveSettingsDebounced();
        renderJobs();
    }
}

function renderToolPrompts() {
    const container = $('#cronjobs_tool_prompts');
    container.empty();
    for (const [key, defaultValue] of Object.entries(DEFAULT_TOOL_PROMPTS)) {
        const block = $('<div></div>').addClass('cronjobs_tool_prompt_block');
        const header = $('<div></div>').addClass('title_restorable');
        const label = $('<label></label>').attr('for', `cronjobs_tool_prompt_${key}`).text(key);
        const restore = $('<button></button>').addClass('menu_button fa-solid fa-undo').attr('title', t`Restore default`).on('click', () => {
            settings().toolPrompts[key] = defaultValue;
            $(`#cronjobs_tool_prompt_${key}`).val(defaultValue);
            registerFunctionTools();
            saveSettingsDebounced();
        });
        const textarea = $('<textarea></textarea>')
            .attr('id', `cronjobs_tool_prompt_${key}`)
            .addClass('text_pole textarea_compact')
            .attr('rows', 2)
            .val(settings().toolPrompts[key])
            .on('input', () => {
                settings().toolPrompts[key] = String(textarea.val());
                registerFunctionTools();
                saveSettingsDebounced();
            });
        header.append(label, restore);
        block.append(header, textarea);
        container.append(block);
    }
}

function updateControls() {
    const enabled = !!settings().enabled;
    $('#cronjobs_enabled').prop('checked', enabled);
    $('#cronjobs_execute_overdue').prop('checked', !!settings().executeOverdueOnOpen).prop('disabled', !enabled);
    $('#cronjobs_tools_enabled').prop('checked', !!settings().functionToolsEnabled);
    $('#cronjobs_max_overdue_age').val(settings().maxOverdueAgeHours);
    $('#cronjobs_max_catchup_runs').val(settings().maxCatchupRuns);
    $('#cronjobs_execution_template').val(settings().executionMessageTemplate || DEFAULT_EXECUTION_TEMPLATE);
}

function updateStatus() {
    const character = getCurrentCharacter();
    const lease = getLeaderLeaseState();
    $('#cronjobs_current_character').text(character ? t`Current character:` + ` ${character.name || character.avatar}` : t`No character selected.`);
    if (lease.state === 'leader') {
        $('#cronjobs_leader_status').text(t`Cron scheduler: this tab is leader.`);
    } else if (lease.state === 'other') {
        $('#cronjobs_leader_status').text(t`Cron scheduler: another tab is leader.` + ` ${t`Lease expires in`} ${Math.ceil(lease.remainingMs / 1000)}s.`);
    } else {
        $('#cronjobs_leader_status').text(t`Cron scheduler: waiting for leader lease.`);
    }
}

function bindSettingsUi() {
    $('#cronjobs_enabled').on('change', function () {
        settings().enabled = !!$(this).prop('checked');
        updateControls();
        saveSettingsDebounced();
    });
    $('#cronjobs_execute_overdue').on('change', function () {
        settings().executeOverdueOnOpen = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#cronjobs_tools_enabled').on('change', function () {
        settings().functionToolsEnabled = !!$(this).prop('checked');
        registerFunctionTools();
        saveSettingsDebounced();
    });
    $('#cronjobs_max_overdue_age').on('input', function () {
        settings().maxOverdueAgeHours = Math.max(0, Number($(this).val()) || 0);
        saveSettingsDebounced();
    });
    $('#cronjobs_max_catchup_runs').on('input', function () {
        settings().maxCatchupRuns = Math.max(1, Number($(this).val()) || 1);
        saveSettingsDebounced();
    });
    $('#cronjobs_execution_template').on('input', function () {
        settings().executionMessageTemplate = String($(this).val());
        saveSettingsDebounced();
    });
    $('#cronjobs_restore_execution_template').on('click', () => {
        settings().executionMessageTemplate = DEFAULT_EXECUTION_TEMPLATE;
        $('#cronjobs_execution_template').val(DEFAULT_EXECUTION_TEMPLATE);
        saveSettingsDebounced();
    });
    $('#cronjobs_new_job').on('click', () => setEditorJob());
    $('#cronjobs_save_job').on('click', () => {
        try {
            const id = String($('#cronjobs_edit_id').val() || '');
            const input = {
                title: String($('#cronjobs_edit_title').val() || ''),
                scheduleType: String($('#cronjobs_edit_schedule_type').val() || 'cron'),
                schedule: String($('#cronjobs_edit_schedule').val() || ''),
                prompt: String($('#cronjobs_edit_prompt').val() || ''),
                enabled: !!$('#cronjobs_edit_enabled').prop('checked'),
            };
            const job = id ? updateJob(id, input) : createJob(input);
            setEditorJob(job);
            renderJobs();
            $('#cronjobs_edit_validation').text(t`Saved.`);
        } catch (error) {
            $('#cronjobs_edit_validation').text(error instanceof Error ? error.message : String(error));
        }
    });
    $('#cronjobs_edit_schedule, #cronjobs_edit_schedule_type').on('input change', () => {
        try {
            const { nextRun } = validateSchedule(String($('#cronjobs_edit_schedule_type').val()), String($('#cronjobs_edit_schedule').val()));
            $('#cronjobs_edit_validation').text(t`Next run:` + ` ${formatDate(nextRun)}`);
        } catch (error) {
            $('#cronjobs_edit_validation').text(error instanceof Error ? error.message : String(error));
        }
    });
}

function startScheduler() {
    if (!leaseTimer) {
        renewLeaderLease();
        leaseTimer = setInterval(renewLeaderLease, LEASE_RENEW_INTERVAL);
    }
    if (!schedulerTimer) {
        schedulerTimer = setInterval(() => checkDueJobs('timer'), SCHEDULER_INTERVAL);
    }
}

function handleLeaseStorageEvent(event) {
    if (event.key === LEASE_KEY) {
        renewLeaderLease();
        checkDueJobs('lease_changed');
    }
}

export async function init() {
    ensureSettings();
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(settingsHtml);
    bindSettingsUi();
    updateControls();
    renderToolPrompts();
    renderJobs();
    registerFunctionTools();
    startScheduler();

    eventSource.on(event_types.APP_READY, () => checkDueJobs('app_ready'));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderJobs();
        setEditorJob();
        checkDueJobs('chat_changed');
    });
    eventSource.on(event_types.GENERATION_ENDED, () => checkDueJobs('generation_ended'));
    eventSource.on(event_types.CHARACTER_RENAMED, onCharacterRenamed);
    eventSource.on(event_types.CHARACTER_DELETED, onCharacterDeleted);
    window.addEventListener('storage', handleLeaseStorageEvent);
    window.addEventListener('pagehide', releaseLeaderLease);
    window.addEventListener('beforeunload', releaseLeaderLease);

    // Useful for debugging from DevTools without exposing a slash command surface.
    globalThis.CronJobsExtension = {
        list: () => getCurrentCharacterJobs().map(summarizeJob),
        check: () => checkDueJobs('manual'),
        tabId: TAB_ID,
        getContext,
        getMessageTimeStamp,
    };
}
