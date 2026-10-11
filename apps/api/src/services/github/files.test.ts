import { parseKeymap, HOST_KEYMAP_SNAPSHOT_PATH } from '@keymap-editor/keymap-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiRequestOptions } from './api.js'
import * as api from './api.js'
import * as auth from './auth.js'
import {
  commitChanges,
  collectHostDeliverables,
  fetchKeyboardFiles,
  findCodeKeymap,
  HOST_DELIVERABLE_MAX_FILES,
  isAllowedHostKeymapPath,
  listConfigDir,
  MissingRepoFile
} from './files.js'

const REPO = 'acme/lark'
const TOKEN = 'install-token'
const KEYMAP_PATH = 'config/lark.keymap'
const TEMPLATE_PATH = 'config/lark.keymap.template'
const DTS = `
/ {
  keymap {
    compatible = "zmk,keymap";
    default_layer {
      bindings = <
&kp A
      >;
    };
  };
};
`

const LISTING = [
  { name: 'info.json', path: 'config/info.json' },
  { name: 'lark.keymap.template', path: TEMPLATE_PATH },
  { name: 'lark.keymap', path: KEYMAP_PATH }
]

const LISTING_NO_TEMPLATE = [
  { name: 'info.json', path: 'config/info.json' },
  { name: 'lark.keymap', path: KEYMAP_PATH }
]

const INFO = { id: 'lark', name: 'LARK' }
const KEYMAP_JSON = {
  keyboard: 'lark',
  keymap: 'lark',
  layout: 'LAYOUT',
  layer_names: ['default'],
  layers: [['&kp A']]
}

const ORIGINAL_SOURCE = `#define FOO BAR

/ {
  keymap {
    compatible = "zmk,keymap";
    default_layer {
      bindings = < &kp A >;
    };
  };
};
`

const NO_KEYMAP_BLOCK = `#define FOO BAR

/ {
  other {
    bindings = < &kp A >;
  };
};
`

const KEYMAP_TEMPLATE = `/* CUSTOM_TEMPLATE */
#include <behaviors.dtsi>

/ {
    keymap {
        compatible = "zmk,keymap";

{{rendered_layers}}
    };
};
`

const ONE_KEY_LAYOUT = [{ x: 0, y: 0, row: 0, col: 0 }]
const EDITED_KEYMAP = parseKeymap({
  layer_names: ['default'],
  layers: [['&kp B']]
})

const CURRENT_COMMIT_SHA = 'current-commit-sha'
const BASE_TREE_SHA = 'base-tree-sha'
const NEW_TREE_SHA = 'new-tree-sha'
const NEW_COMMIT_SHA = 'new-commit-sha'

const GENERATED_BANNER = 'THIS FILE WAS GENERATED'

function ok(data: unknown) {
  return { data, headers: {}, status: 200 }
}

function notFound() {
  return Object.assign(new Error('GitHub API 404'), {
    response: { status: 404 }
  })
}

function requestUrl(options: ApiRequestOptions | string): string {
  return typeof options === 'string' ? options : options.url
}

function requestMethod(options: ApiRequestOptions | string): string {
  if (typeof options === 'string') return 'GET'
  return (options.method || (options.data ? 'POST' : 'GET')).toUpperCase()
}

function contentsPath(url: string): string | null {
  const prefix = `/repos/${REPO}/contents/`
  return url.startsWith(prefix) ? url.slice(prefix.length) : null
}

function resolveMockValue(value: unknown, options: ApiRequestOptions | string): unknown {
  if (typeof value === 'function') {
    return (value as (opts: ApiRequestOptions | string) => unknown)(options)
  }
  return value
}

function mockGithub(
  files: Record<string, unknown>,
  options: { missing?: string[]; errors?: Record<string, number> } = {}
) {
  const missing = new Set(options.missing ?? [])
  const errors = options.errors ?? {}
  const catalog: Record<string, unknown> = {
    [`GET /repos/${REPO}`]: { default_branch: 'main' },
    [`GET /repos/${REPO}/commits/main`]: {
      sha: CURRENT_COMMIT_SHA,
      commit: { tree: { sha: BASE_TREE_SHA } }
    },
    ...files
  }
  return vi.spyOn(api, 'request').mockImplementation(async options => {
    const url = requestUrl(options)
    const method = requestMethod(options)
    const path = contentsPath(url)
    if (path !== null && missing.has(path)) throw notFound()
    if (path !== null && path in errors) {
      throw Object.assign(new Error(`GitHub API ${errors[path]}`), {
        response: { status: errors[path] }
      })
    }

    const methodUrl = `${method} ${url}`
    if (methodUrl in catalog) return ok(resolveMockValue(catalog[methodUrl], options))
    if (url in catalog) return ok(resolveMockValue(catalog[url], options))
    if (path !== null && path in files) return ok(resolveMockValue(files[path], options))

    throw new Error(`unexpected GitHub request: ${method} ${url}`)
  })
}

function gitCommitEndpoints(
  branch: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    [`GET /repos/${REPO}/commits/${branch}`]: {
      sha: CURRENT_COMMIT_SHA,
      commit: { tree: { sha: BASE_TREE_SHA } }
    },
    [`POST /repos/${REPO}/git/trees`]: { sha: NEW_TREE_SHA },
    [`POST /repos/${REPO}/git/commits`]: { sha: NEW_COMMIT_SHA },
    [`PATCH /repos/${REPO}/git/refs/heads/${branch}`]: {},
    ...overrides
  }
}

function requestOptions(request: { mock: { calls: unknown[][] } }): ApiRequestOptions[] {
  return request.mock.calls.map(call => call[0] as ApiRequestOptions)
}

function findRequest(
  request: { mock: { calls: unknown[][] } },
  method: string,
  url: string
): ApiRequestOptions | undefined {
  return requestOptions(request).find(
    opts => requestMethod(opts) === method && requestUrl(opts) === url
  )
}

function bytesBeforeKeymapBlock(source: string): string {
  const match = /\bkeymap\s*\{/.exec(source)
  if (!match) {
    throw new Error('expected a keymap { block')
  }
  return source.slice(0, match.index)
}

function treeBlobs(request: { mock: { calls: unknown[][] } }) {
  const treeReq = findRequest(request, 'POST', `/repos/${REPO}/git/trees`)
  const data = treeReq?.data as {
    base_tree?: string
    tree?: Array<{ path: string; content: string }>
  }
  return data
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isAllowedHostKeymapPath', () => {
  it('allows snapshot and single-segment linux/windows deliverables', () => {
    expect(isAllowedHostKeymapPath(HOST_KEYMAP_SNAPSHOT_PATH)).toBe(true)
    expect(isAllowedHostKeymapPath('host_keymap/linux/ru.xkb')).toBe(true)
    expect(isAllowedHostKeymapPath('host_keymap/windows/en-ru.klc')).toBe(true)
  })

  it('rejects traversal, absolute, and out-of-allowlist paths', () => {
    expect(isAllowedHostKeymapPath('host_keymap/../config/evil.keymap')).toBe(false)
    expect(isAllowedHostKeymapPath('host_keymap/linux/../windows/x.klc')).toBe(false)
    expect(isAllowedHostKeymapPath('/host_keymap/linux/ru.xkb')).toBe(false)
    expect(isAllowedHostKeymapPath('config/keymap.json')).toBe(false)
    expect(isAllowedHostKeymapPath('host_keymap/extra/ru.xkb')).toBe(false)
    expect(isAllowedHostKeymapPath('host_keymap/linux/nested/ru.xkb')).toBe(false)
    expect(isAllowedHostKeymapPath('evil/../escape.txt')).toBe(false)
  })
})

describe('collectHostDeliverables', () => {
  const linux = {
    path: 'host_keymap/linux/ru.xkb',
    content: 'xkb\n'
  }

  it('drops the snapshot path, duplicates, and over-limit files with warnings', () => {
    const extra = Array.from({ length: HOST_DELIVERABLE_MAX_FILES }, (_, i) => ({
      path: `host_keymap/linux/f${i}.xkb`,
      content: `${i}\n`
    }))
    const { files, warnings } = collectHostDeliverables([
      { path: HOST_KEYMAP_SNAPSHOT_PATH, content: '{}\n' },
      linux,
      { ...linux },
      { path: 'evil/../escape.txt', content: 'nope' },
      ...extra
    ])

    expect(files).toHaveLength(HOST_DELIVERABLE_MAX_FILES)
    expect(files[0]).toEqual(linux)
    expect(files.some(file => file.path === HOST_KEYMAP_SNAPSHOT_PATH)).toBe(false)
    expect(warnings.some(w => w.includes(HOST_KEYMAP_SNAPSHOT_PATH))).toBe(true)
    expect(warnings.some(w => w.includes('duplicate'))).toBe(true)
    expect(warnings.some(w => w.includes(`limit ${HOST_DELIVERABLE_MAX_FILES}`))).toBe(
      true
    )
  })
})

describe('listConfigDir', () => {
  it('lists config once and forwards the branch', async () => {
    const request = mockGithub({ config: LISTING })
    const listing = await listConfigDir(TOKEN, REPO, 'main')
    expect(listing).toEqual(LISTING)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `/repos/${REPO}/contents/config`,
        token: TOKEN,
        params: { ref: 'main' }
      })
    )
  })
})

describe('findCodeKeymap', () => {
  it('picks the user keymap and ignores the template', () => {
    expect(findCodeKeymap(LISTING)).toEqual({
      name: 'lark.keymap',
      path: KEYMAP_PATH
    })
  })

  it('throws when no user keymap is listed', () => {
    expect(() =>
      findCodeKeymap([{ name: 'info.json', path: 'config/info.json' }])
    ).toThrow(MissingRepoFile)
  })
})

describe('fetchKeyboardFiles', () => {
  beforeEach(() => {
    vi.spyOn(auth, 'createInstallationToken').mockResolvedValue({
      data: { token: TOKEN }
    } as Awaited<ReturnType<typeof auth.createInstallationToken>>)
  })

  it('reads hold-tap nodes from .keymap when keymap.json does not list them', async () => {
    const dts = `&mt {\n    flavor = "tap-preferred";\n    tapping-term-ms = <300>;\n};\n${DTS}`
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        'config/keymap.json': JSON.stringify(KEYMAP_JSON),
        [KEYMAP_PATH]: dts
      },
      { missing: [HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO, 'main')

    expect(result.keymap).toMatchObject({
      ...KEYMAP_JSON,
      holdTaps: [
        { code: '&mt', override: true, flavor: 'tap-preferred', tappingTermMs: 300 }
      ]
    })
    expect(result.hostSnapshot).toBeNull()
    expect(requestUrls(request).filter(url => url.endsWith('/contents/config'))).toHaveLength(
      1
    )
    expect(requestUrls(request).some(url => url.endsWith(`/${KEYMAP_PATH}`))).toBe(true)
  })

  it('does not download .keymap when keymap.json already lists holdTaps', async () => {
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        'config/keymap.json': JSON.stringify({
          ...KEYMAP_JSON,
          holdTaps: [],
          sensorBindings: []
        })
      },
      { missing: [HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO, 'main')

    expect(result.keymap).toEqual({ ...KEYMAP_JSON, holdTaps: [], sensorBindings: [] })
    expect(requestUrls(request).some(url => url.endsWith(`/${KEYMAP_PATH}`))).toBe(false)
  })

  it('lists config once and downloads .keymap only once when keymap.json is missing', async () => {
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        [KEYMAP_PATH]: DTS
      },
      { missing: ['config/keymap.json', HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)

    expect(result.keymap.layers[0]).toEqual(['&kp A'])
    expect(requestUrls(request).filter(url => url.endsWith('/contents/config'))).toHaveLength(
      1
    )
    expect(
      requestUrls(request).filter(url => url.endsWith(`/${KEYMAP_PATH}`))
    ).toHaveLength(1)
  })

  it('falls back to .keymap when keymap.json is not JSON', async () => {
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        'config/keymap.json': 'not-json',
        [KEYMAP_PATH]: DTS
      },
      { missing: [HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)

    expect(result.keymap.layers[0]).toEqual(['&kp A'])
    expect(
      requestUrls(request).filter(url => url.endsWith(`/${KEYMAP_PATH}`))
    ).toHaveLength(1)
  })

  it('falls back to .keymap when keymap.json is not primary and skips the template', async () => {
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        'config/keymap.json': JSON.stringify({ layers: [] }),
        [KEYMAP_PATH]: DTS
      },
      { missing: [HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)

    expect(result.keymap.layers[0]).toEqual(['&kp A'])
    expect(
      requestUrls(request).filter(url => url.endsWith(`/${KEYMAP_PATH}`))
    ).toHaveLength(1)
    expect(requestUrls(request).some(url => url.endsWith(`/${TEMPLATE_PATH}`))).toBe(false)
  })

  it('rethrows a non-404 keymap.json error without downloading .keymap', async () => {
    const request = mockGithub(
      {
        'config/info.json': JSON.stringify(INFO),
        config: LISTING,
        [KEYMAP_PATH]: DTS
      },
      {
        missing: [HOST_KEYMAP_SNAPSHOT_PATH],
        errors: { 'config/keymap.json': 500 }
      }
    )

    await expect(fetchKeyboardFiles('1', REPO)).rejects.toMatchObject({
      response: { status: 500 }
    })
    expect(requestUrls(request).some(url => url.endsWith(`/${KEYMAP_PATH}`))).toBe(false)
  })

  it('returns null info when info.json is missing', async () => {
    const listing = [
      { name: 'lark.keymap', path: KEYMAP_PATH },
      { name: 'keymap.json', path: 'config/keymap.json' }
    ]
    mockGithub(
      {
        config: listing,
        'config/keymap.json': JSON.stringify(KEYMAP_JSON)
      },
      { missing: ['config/info.json', 'config/lark.json', HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)
    expect(result.info).toBeNull()
    expect(result.keymap).toEqual(KEYMAP_JSON)
  })

  it('does not treat keymap.json as layout metadata for keymap.keymap', async () => {
    const keymapPath = 'config/keymap.keymap'
    const listing = [
      { name: 'keymap.keymap', path: keymapPath },
      { name: 'keymap.json', path: 'config/keymap.json' }
    ]
    const request = mockGithub(
      {
        config: listing,
        'config/keymap.json': JSON.stringify(KEYMAP_JSON)
      },
      { missing: ['config/info.json', HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)

    expect(result.info).toBeNull()
    expect(result.keymap).toEqual(KEYMAP_JSON)
    expect(
      requestUrls(request).filter(url => url.endsWith('/contents/config/keymap.json'))
    ).toHaveLength(1)
  })

  it('uses the matching keymap JSON layout when info.json is missing', async () => {
    const namedInfo = {
      id: 'lark',
      name: 'LARK',
      layouts: {
        default_layout: {
          layout: [{ x: 0, y: 0, row: 0, col: 0 }]
        }
      }
    }
    const listing = [
      { name: 'lark.keymap', path: KEYMAP_PATH },
      { name: 'lark.json', path: 'config/lark.json' },
      { name: 'keymap.json', path: 'config/keymap.json' }
    ]
    const request = mockGithub(
      {
        config: listing,
        'config/lark.json': JSON.stringify(namedInfo),
        'config/keymap.json': JSON.stringify(KEYMAP_JSON)
      },
      { missing: ['config/info.json', HOST_KEYMAP_SNAPSHOT_PATH] }
    )

    const result = await fetchKeyboardFiles('1', REPO)

    expect(result.info).toEqual(namedInfo)
    expect(requestUrls(request)).toContain(`/repos/${REPO}/contents/config/lark.json`)
  })

  it('returns a parsed host snapshot when host_keymap/snapshot.json exists', async () => {
    const hostSnapshot = {
      version: 1,
      view: {
        columns: [
          {
            language: 'en',
            layoutId: 'system-us',
            visible: true,
            altGr: true,
            altGrShift: true
          }
        ],
        open: null
      },
      layouts: []
    }
    mockGithub({
      'config/info.json': JSON.stringify(INFO),
      config: LISTING,
      'config/keymap.json': JSON.stringify(KEYMAP_JSON),
      [HOST_KEYMAP_SNAPSHOT_PATH]: JSON.stringify(hostSnapshot)
    })

    const result = await fetchKeyboardFiles('1', REPO, 'main')
    expect(result.hostSnapshot).toEqual(hostSnapshot)
  })

  it('resolves head first and pins every contents read to that sha', async () => {
    const request = mockGithub({
      [`GET /repos/${REPO}/commits/main`]: {
        sha: CURRENT_COMMIT_SHA,
        commit: { tree: { sha: BASE_TREE_SHA } }
      },
      'config/info.json': JSON.stringify(INFO),
      config: LISTING,
      'config/keymap.json': JSON.stringify(KEYMAP_JSON)
    }, { missing: [HOST_KEYMAP_SNAPSHOT_PATH] })

    const result = await fetchKeyboardFiles('1', REPO, 'main')

    expect(result.headSha).toBe(CURRENT_COMMIT_SHA)
    expect(requestUrl(request.mock.calls[0][0] as ApiRequestOptions)).toBe(
      `/repos/${REPO}/commits/main`
    )

    const contentReads = requestOptions(request).filter(
      opts => contentsPath(requestUrl(opts)) !== null
    )
    expect(contentReads.length).toBeGreaterThan(0)
    for (const opts of contentReads) {
      expect(opts.params).toEqual({ ref: CURRENT_COMMIT_SHA })
    }
  })
})

function requestUrls(request: { mock: { calls: unknown[][] } }): string[] {
  return request.mock.calls.map(call => requestUrl(call[0] as ApiRequestOptions | string))
}

describe('commitChanges', () => {
  beforeEach(() => {
    vi.spyOn(auth, 'createInstallationToken').mockResolvedValue({
      data: { token: TOKEN }
    } as Awaited<ReturnType<typeof auth.createInstallationToken>>)
  })

  it('uses .keymap.template when listed and commits the user keymap path plus keymap.json', async () => {
    const request = mockGithub({
      config: LISTING,
      [TEMPLATE_PATH]: KEYMAP_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })

    const result = await commitChanges(
      '1',
      REPO,
      'main',
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      null,
      null,
      CURRENT_COMMIT_SHA
    )

    expect(result.mode).toBe('template')
    expect(
      requestUrls(request).some(url => url.endsWith(`/contents/${TEMPLATE_PATH}`))
    ).toBe(true)

    const blobs = treeBlobs(request)
    expect(blobs.tree?.map(blob => blob.path)).toEqual([KEYMAP_PATH, 'config/keymap.json'])

    const keymapBody = blobs.tree?.find(blob => blob.path === KEYMAP_PATH)?.content ?? ''
    expect(keymapBody).toContain('CUSTOM_TEMPLATE')
    expect(keymapBody).toContain('&kp B')
    expect(KEYMAP_TEMPLATE).not.toContain(GENERATED_BANNER)
    expect(keymapBody).not.toContain(GENERATED_BANNER)
  })

  it('splices into the original .keymap when no template is listed', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })

    const result = await commitChanges(
      '1',
      REPO,
      'main',
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      null,
      null,
      CURRENT_COMMIT_SHA
    )

    expect(result.mode).toBe('splice')
    expect(
      requestUrls(request).some(url => url.endsWith(`/contents/${TEMPLATE_PATH}`))
    ).toBe(false)

    const keymapBody =
      treeBlobs(request).tree?.find(blob => blob.path === KEYMAP_PATH)?.content ?? ''
    expect(bytesBeforeKeymapBlock(keymapBody)).toBe(bytesBeforeKeymapBlock(ORIGINAL_SOURCE))
    expect(keymapBody).toContain('#define FOO BAR')
    expect(keymapBody).toContain('&kp B')
  })

  it('walks commits → trees → git commits → ref update with matching shas', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })

    await commitChanges(
      '1',
      REPO,
      'main',
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      null,
      null,
      CURRENT_COMMIT_SHA
    )

    const trees = findRequest(request, 'POST', `/repos/${REPO}/git/trees`)
    expect(trees?.data).toEqual(
      expect.objectContaining({
        base_tree: BASE_TREE_SHA
      })
    )

    const commit = findRequest(request, 'POST', `/repos/${REPO}/git/commits`)
    expect(commit?.data).toEqual(
      expect.objectContaining({
        tree: NEW_TREE_SHA,
        parents: [CURRENT_COMMIT_SHA]
      })
    )

    const ref = findRequest(request, 'PATCH', `/repos/${REPO}/git/refs/heads/main`)
    expect(ref?.data).toEqual({ sha: NEW_COMMIT_SHA })
  })

  it('does not PATCH the ref when creating the tree fails', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main', {
        [`POST /repos/${REPO}/git/trees`]: () => {
          throw new Error('tree create failed')
        }
      })
    })

    await expect(
      commitChanges(
        '1',
        REPO,
        'main',
        ONE_KEY_LAYOUT,
        EDITED_KEYMAP,
        null,
        null,
        CURRENT_COMMIT_SHA
      )
    ).rejects.toThrow('tree create failed')

    expect(findRequest(request, 'PATCH', `/repos/${REPO}/git/refs/heads/main`)).toBeUndefined()
    expect(requestUrls(request).some(url => url.includes('/git/refs/'))).toBe(false)
  })

  it('keeps slashes literal and percent-encodes # and % in commit and ref paths', async () => {
    const branch = 'feature/x#y%'
    const encoded = 'feature/x%23y%25'
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints(encoded)
    })

    await commitChanges(
      '1',
      REPO,
      branch,
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      null,
      null,
      CURRENT_COMMIT_SHA
    )

    expect(findRequest(request, 'GET', `/repos/${REPO}/commits/${encoded}`)).toBeDefined()
    expect(
      findRequest(request, 'PATCH', `/repos/${REPO}/git/refs/heads/${encoded}`)
    ).toBeDefined()
    expect(requestUrls(request).some(url => url.includes('feature%2Fx'))).toBe(false)
  })

  it('does not PATCH when splice fails without a keymap block or template', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: NO_KEYMAP_BLOCK,
      ...gitCommitEndpoints('main')
    })

    await expect(
      commitChanges(
        '1',
        REPO,
        'main',
        ONE_KEY_LAYOUT,
        EDITED_KEYMAP,
        null,
        null,
        CURRENT_COMMIT_SHA
      )
    ).rejects.toThrow(/compatible = "zmk,keymap"/)

    expect(findRequest(request, 'PATCH', `/repos/${REPO}/git/refs/heads/main`)).toBeUndefined()
    expect(requestUrls(request).some(url => url.includes('/git/refs/'))).toBe(false)
    expect(findRequest(request, 'POST', `/repos/${REPO}/git/trees`)).toBeUndefined()
  })

  it('writes host_keymap/snapshot.json in the same tree when a snapshot is provided', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })
    const hostSnapshot = {
      version: 1 as const,
      view: {
        columns: [
          {
            language: 'en' as const,
            layoutId: 'system-us',
            visible: true,
            altGr: true,
            altGrShift: true
          }
        ],
        open: null
      },
      layouts: []
    }

    await commitChanges(
      '1',
      REPO,
      'main',
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      hostSnapshot,
      null,
      CURRENT_COMMIT_SHA
    )

    const blobs = treeBlobs(request)
    expect(blobs.tree?.map(blob => blob.path)).toEqual([
      KEYMAP_PATH,
      'config/keymap.json',
      HOST_KEYMAP_SNAPSHOT_PATH
    ])
    expect(
      blobs.tree?.find(blob => blob.path === HOST_KEYMAP_SNAPSHOT_PATH)?.content
    ).toContain('"version": 1')
  })

  it('writes host deliverable files beside the snapshot', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })
    const hostSnapshot = {
      version: 1 as const,
      view: {
        columns: [
          {
            language: 'en' as const,
            layoutId: 'system-us',
            visible: true,
            altGr: true,
            altGrShift: true
          }
        ],
        open: null
      },
      layouts: []
    }
    const hostDeliverables = [
      {
        path: 'host_keymap/linux/ru.xkb',
        content: 'xkb_symbols "ru" { };\n'
      },
      {
        path: 'host_keymap/windows/ru.klc',
        content: 'KBD\tru\t"Russian"\r\n'
      },
      {
        path: 'evil/../escape.txt',
        content: 'nope'
      },
      {
        path: 'host_keymap/../config/evil.keymap',
        content: 'traversal'
      },
      {
        path: '/host_keymap/linux/abs.xkb',
        content: 'absolute'
      },
      {
        path: HOST_KEYMAP_SNAPSHOT_PATH,
        content: '{"version":1}\n'
      }
    ]

    const result = await commitChanges(
      '1',
      REPO,
      'main',
      ONE_KEY_LAYOUT,
      EDITED_KEYMAP,
      hostSnapshot,
      hostDeliverables,
      CURRENT_COMMIT_SHA
    )

    const paths = treeBlobs(request).tree?.map(blob => blob.path) ?? []
    expect(paths).toEqual([
      KEYMAP_PATH,
      'config/keymap.json',
      HOST_KEYMAP_SNAPSHOT_PATH,
      'host_keymap/linux/ru.xkb',
      'host_keymap/windows/ru.klc'
    ])
    expect(result.warnings.some(w => w.includes(HOST_KEYMAP_SNAPSHOT_PATH))).toBe(true)
  })

  it('rejects when baseSha does not match the current head', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main')
    })

    await expect(
      commitChanges(
        '1',
        REPO,
        'main',
        ONE_KEY_LAYOUT,
        EDITED_KEYMAP,
        null,
        null,
        'stale-sha'
      )
    ).rejects.toMatchObject({
      name: 'StaleRepoBase',
      errors: ['Branch changed on GitHub — reload']
    })

    expect(findRequest(request, 'POST', `/repos/${REPO}/git/trees`)).toBeUndefined()
    expect(
      requestOptions(request).filter(opts => contentsPath(requestUrl(opts)) !== null)
    ).toHaveLength(0)
  })

  it('pins commit contents reads to the head sha and rethrows PATCH 422', async () => {
    const request = mockGithub({
      config: LISTING_NO_TEMPLATE,
      [KEYMAP_PATH]: ORIGINAL_SOURCE,
      ...gitCommitEndpoints('main', {
        [`PATCH /repos/${REPO}/git/refs/heads/main`]: () => {
          throw Object.assign(new Error('GitHub API 422'), {
            response: { status: 422, data: 'Update is not a fast forward' }
          })
        }
      })
    })

    await expect(
      commitChanges(
        '1',
        REPO,
        'main',
        ONE_KEY_LAYOUT,
        EDITED_KEYMAP,
        null,
        null,
        CURRENT_COMMIT_SHA
      )
    ).rejects.toMatchObject({ response: { status: 422 } })

    const contentReads = requestOptions(request).filter(
      opts => contentsPath(requestUrl(opts)) !== null
    )
    expect(contentReads.length).toBeGreaterThan(0)
    for (const opts of contentReads) {
      expect(opts.params).toEqual({ ref: CURRENT_COMMIT_SHA })
    }
  })
})
