import path from 'node:path'
import {
  buildKeymapCode,
  encodeHostKeymapSnapshot,
  HOST_KEYMAP_SNAPSHOT_PATH,
  isPrimaryKeymapJson,
  isUserKeymapFilename,
  matchingInfoJsonFilename,
  parseDtsKeymap,
  parseHostKeymapSnapshot,
  type HostKeymapDeliverableFile,
  type HostKeymapSnapshot,
  type LayoutKey,
  type ParsedKeymap
} from '@keymap-editor/keymap-core'
import * as api from './api.js'
import * as auth from './auth.js'

const MODE_FILE = '100644'
const HOST_KEYMAP_LINUX_PREFIX = 'host_keymap/linux/'
const HOST_KEYMAP_WINDOWS_PREFIX = 'host_keymap/windows/'

/**
 * True when a commit blob path is a safe host_keymap deliverable or snapshot.
 * Rejects traversal (`..`), absolute paths, and anything outside the allowlist.
 */
export function isAllowedHostKeymapPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath) return false
  if (filePath.includes('\0')) return false
  if (filePath.startsWith('/') || path.win32.isAbsolute(filePath)) return false
  if (filePath.split(/[/\\]/).includes('..')) return false

  const normalized = path.posix.normalize(filePath)
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    return false
  }
  if (normalized.split('/').includes('..')) return false

  if (normalized === HOST_KEYMAP_SNAPSHOT_PATH) return true

  for (const prefix of [HOST_KEYMAP_LINUX_PREFIX, HOST_KEYMAP_WINDOWS_PREFIX]) {
    if (!normalized.startsWith(prefix)) continue
    const rest = normalized.slice(prefix.length)
    if (rest && !rest.includes('/') && rest !== '.' && rest !== '..') return true
  }
  return false
}

export const HOST_DELIVERABLE_MAX_FILES = 32

export function collectHostDeliverables(
  files: HostKeymapDeliverableFile[] | null | undefined
): { files: HostKeymapDeliverableFile[]; warnings: string[] } {
  const selected: HostKeymapDeliverableFile[] = []
  const warnings: string[] = []
  if (!Array.isArray(files)) return { files: selected, warnings }

  const seen = new Set<string>()
  for (const file of files) {
    if (!file?.path || typeof file.content !== 'string') {
      warnings.push('Skipped host deliverable with missing path or content')
      continue
    }
    const normalized = path.posix.normalize(file.path)
    if (normalized === HOST_KEYMAP_SNAPSHOT_PATH) {
      warnings.push(`Skipped host deliverable ${normalized}`)
      continue
    }
    if (!isAllowedHostKeymapPath(file.path)) {
      warnings.push(`Skipped host deliverable ${file.path}`)
      continue
    }
    if (seen.has(normalized)) {
      warnings.push(`Skipped duplicate host deliverable ${normalized}`)
      continue
    }
    if (selected.length >= HOST_DELIVERABLE_MAX_FILES) {
      warnings.push(
        `Skipped host deliverable ${normalized} (limit ${HOST_DELIVERABLE_MAX_FILES})`
      )
      continue
    }
    seen.add(normalized)
    selected.push({ path: normalized, content: file.content })
  }
  return { files: selected, warnings }
}

interface ConfigDirEntry {
  name: string
  path: string
}

type ConfigDirListing = ReadonlyArray<ConfigDirEntry>

export const BRANCH_CHANGED_NOTICE = 'Branch changed on GitHub — reload'

export class MissingRepoFile extends Error {
  path: string
  errors: string[]

  constructor(filePath: string) {
    super()
    this.name = 'MissingRepoFile'
    this.path = filePath
    this.errors = [`Missing file ${filePath}`]
  }
}

export class StaleRepoBase extends Error {
  errors: string[]

  constructor() {
    super(BRANCH_CHANGED_NOTICE)
    this.name = 'StaleRepoBase'
    this.errors = [BRANCH_CHANGED_NOTICE]
  }
}

type HeadCommit = { sha: string; treeSha: string }

async function resolveHeadCommit(
  installationToken: string,
  repository: string,
  branch?: string
): Promise<HeadCommit> {
  let ref = branch
  if (!ref) {
    const { data: repo } = await api.request({
      url: api.githubApiPath('repos', repository),
      token: installationToken
    })
    ref = (repo as { default_branch?: string }).default_branch
    if (!ref) throw new Error('Repository has no default branch')
  }
  const { data } = await api.request({
    url: api.githubApiPath('repos', repository, 'commits', ref),
    token: installationToken
  })
  const commit = data as { sha?: string; commit?: { tree?: { sha?: string } } }
  if (!commit.sha || !commit.commit?.tree?.sha) {
    throw new Error('Could not resolve repository head')
  }
  return { sha: commit.sha, treeSha: commit.commit.tree.sha }
}

async function fetchFile(
  installationToken: string,
  repository: string,
  filePath: string,
  options: { raw?: boolean; ref?: string | null } = {}
) {
  const { raw = false, ref = null } = options
  const url = api.githubApiPath('repos', repository, 'contents', filePath)
  const params: Record<string, string> = {}
  if (ref) params.ref = ref

  const headers: Record<string, string> = {
    Accept: raw ? 'application/vnd.github.v3.raw' : 'application/json'
  }

  try {
    return await api.request({ url, headers, params, token: installationToken })
  } catch (err) {
    const e = err as { response?: { status: number } }
    if (e.response?.status === 404) {
      throw new MissingRepoFile(filePath)
    }
    throw err
  }
}

function parseJsonBody(data: unknown): unknown {
  if (typeof data === 'string') {
    return JSON.parse(data)
  }
  return data
}

export async function listConfigDir(
  token: string,
  repository: string,
  ref?: string
): Promise<ConfigDirEntry[]> {
  const { data: directory } = await fetchFile(token, repository, 'config', {
    ref
  })
  return directory as ConfigDirEntry[]
}

export function findCodeKeymap(listing: ConfigDirListing): ConfigDirEntry {
  const originalCodeKeymap = listing.find(file => isUserKeymapFilename(file.name))
  if (!originalCodeKeymap) {
    throw new MissingRepoFile('config/*.keymap')
  }
  return originalCodeKeymap
}

async function findCodeKeymapTemplate(
  listing: ConfigDirListing,
  installationToken: string,
  repository: string,
  ref?: string
) {
  const template = listing.find(file =>
    file.name.toLowerCase().endsWith('.keymap.template')
  )
  if (template) {
    const { data: content } = await fetchFile(
      installationToken,
      repository,
      template.path,
      { ref, raw: true }
    )
    return content as string
  }
}

async function fetchKeymapFromDts(
  installationToken: string,
  repository: string,
  originalCodeKeymap: ConfigDirEntry,
  ref?: string
) {
  const { data: source } = await fetchFile(
    installationToken,
    repository,
    originalCodeKeymap.path,
    { raw: true, ref }
  )
  const text = typeof source === 'string' ? source : String(source)
  const keymapName = originalCodeKeymap.name.replace(/\.keymap$/i, '')
  return parseDtsKeymap(text, {
    keyboard: 'unknown',
    keymap: keymapName,
    layout: 'LAYOUT'
  })
}

async function fetchKeymap(
  installationToken: string,
  repository: string,
  originalCodeKeymap: ConfigDirEntry,
  ref?: string
) {
  try {
    const { data } = await fetchFile(installationToken, repository, 'config/keymap.json', {
      raw: true,
      ref
    })
    try {
      const parsed = parseJsonBody(data)
      if (isPrimaryKeymapJson(parsed)) {
        const record =
          parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        // Older keymap.json files omit holdTaps and sensorBindings. Read them
        // from the .keymap once; a later save records the arrays and skips this.
        const needsHoldTaps =
          record != null && !Object.prototype.hasOwnProperty.call(record, 'holdTaps')
        const needsSensors =
          record != null && !Object.prototype.hasOwnProperty.call(record, 'sensorBindings')
        if (needsHoldTaps || needsSensors) {
          try {
            const fromDts = await fetchKeymapFromDts(
              installationToken,
              repository,
              originalCodeKeymap,
              ref
            )
            return {
              ...record,
              ...(needsHoldTaps ? { holdTaps: fromDts.holdTaps ?? [] } : {}),
              ...(needsSensors ? { sensorBindings: fromDts.sensorBindings ?? [] } : {})
            }
          } catch {
            // JSON layers still load when the .keymap cannot be read.
          }
        }
        return parsed
      }
    } catch {
      /* unparsable or invalid — fall through to .keymap */
    }
  } catch (err) {
    if (!(err instanceof MissingRepoFile)) {
      throw err
    }
  }

  return fetchKeymapFromDts(installationToken, repository, originalCodeKeymap, ref)
}

async function fetchHostKeymapSnapshot(
  installationToken: string,
  repository: string,
  ref?: string
): Promise<HostKeymapSnapshot | null> {
  try {
    const { data } = await fetchFile(
      installationToken,
      repository,
      HOST_KEYMAP_SNAPSHOT_PATH,
      { raw: true, ref }
    )
    const result = parseHostKeymapSnapshot(
      typeof data === 'string' ? data : parseJsonBody(data)
    )
    return result.ok ? result.snapshot : null
  } catch (err) {
    if (err instanceof MissingRepoFile) return null
    throw err
  }
}

function matchingInfoPath(keymap: ConfigDirEntry): string | null {
  const filename = matchingInfoJsonFilename(keymap.name)
  return filename ? path.posix.join(path.posix.dirname(keymap.path), filename) : null
}

async function fetchInfoJson(
  installationToken: string,
  repository: string,
  originalCodeKeymap: ConfigDirEntry,
  ref?: string
): Promise<unknown | null> {
  try {
    const { data: infoRaw } = await fetchFile(
      installationToken,
      repository,
      'config/info.json',
      { raw: true, ref }
    )
    return parseJsonBody(infoRaw)
  } catch (err) {
    if (!(err instanceof MissingRepoFile)) throw err
  }

  const fallbackPath = matchingInfoPath(originalCodeKeymap)
  if (!fallbackPath) return null

  try {
    const { data: infoRaw } = await fetchFile(
      installationToken,
      repository,
      fallbackPath,
      { raw: true, ref }
    )
    return parseJsonBody(infoRaw)
  } catch (err) {
    if (err instanceof MissingRepoFile) return null
    throw err
  }
}

export async function fetchKeyboardFiles(
  installationId: string,
  repository: string,
  branch?: string
) {
  const { data } = await auth.createInstallationToken(installationId, { repository })
  const installationToken = (data as { token: string }).token
  const head = await resolveHeadCommit(installationToken, repository, branch)
  const ref = head.sha
  const [listing, hostSnapshot] = await Promise.all([
    listConfigDir(installationToken, repository, ref),
    fetchHostKeymapSnapshot(installationToken, repository, ref)
  ])
  const originalCodeKeymap = findCodeKeymap(listing)
  const [info, keymap] = await Promise.all([
    fetchInfoJson(installationToken, repository, originalCodeKeymap, ref),
    fetchKeymap(installationToken, repository, originalCodeKeymap, ref)
  ])
  return { info, keymap, hostSnapshot, headSha: head.sha }
}

export async function commitChanges(
  installationId: string,
  repository: string,
  branch: string,
  layout: LayoutKey[],
  keymap: ParsedKeymap,
  hostSnapshot?: HostKeymapSnapshot | null,
  hostDeliverables?: HostKeymapDeliverableFile[] | null,
  baseSha?: string | null
) {
  const { data } = await auth.createInstallationToken(installationId, { repository })
  const installationToken = (data as { token: string }).token
  const head = await resolveHeadCommit(installationToken, repository, branch)
  if (typeof baseSha !== 'string' || !baseSha || baseSha !== head.sha) {
    throw new StaleRepoBase()
  }
  const ref = head.sha
  const listing = await listConfigDir(installationToken, repository, ref)
  const originalCodeKeymap = findCodeKeymap(listing)
  const [template, originalSourceResult] = await Promise.all([
    findCodeKeymapTemplate(listing, installationToken, repository, ref),
    fetchFile(installationToken, repository, originalCodeKeymap.path, {
      raw: true,
      ref
    })
  ])
  const originalSourceRaw = originalSourceResult.data
  const originalSource =
    typeof originalSourceRaw === 'string' ? originalSourceRaw : String(originalSourceRaw)

  const built = buildKeymapCode(layout, keymap, { template, originalSource })
  const sha = head.sha
  const treeSha = head.treeSha

  const tree: Array<{ path: string; mode: string; type: string; content: string }> = [
    {
      path: originalCodeKeymap.path,
      mode: MODE_FILE,
      type: 'blob',
      content: built.code
    },
    {
      path: 'config/keymap.json',
      mode: MODE_FILE,
      type: 'blob',
      content: built.json
    }
  ]
  const deliverable = collectHostDeliverables(hostDeliverables)
  if (hostSnapshot) {
    tree.push({
      path: HOST_KEYMAP_SNAPSHOT_PATH,
      mode: MODE_FILE,
      type: 'blob',
      content: encodeHostKeymapSnapshot(hostSnapshot)
    })
    for (const file of deliverable.files) {
      tree.push({
        path: file.path,
        mode: MODE_FILE,
        type: 'blob',
        content: file.content
      })
    }
  }

  const { data: treeData } = await api.request({
    url: api.githubApiPath('repos', repository, 'git', 'trees'),
    method: 'POST',
    token: installationToken,
    data: {
      base_tree: treeSha,
      tree
    }
  })
  const newTreeSha = (treeData as { sha: string }).sha

  const { data: newCommit } = await api.request({
    url: api.githubApiPath('repos', repository, 'git', 'commits'),
    method: 'POST',
    token: installationToken,
    data: {
      tree: newTreeSha,
      message: 'Updated keymap',
      parents: [sha]
    }
  })
  const newSha = (newCommit as { sha: string }).sha

  await api.request({
    url: api.githubApiPath('repos', repository, 'git', 'refs', 'heads', branch),
    method: 'PATCH',
    token: installationToken,
    data: { sha: newSha }
  })

  return {
    mode: built.mode,
    warnings: [...built.warnings, ...deliverable.warnings]
  }
}
