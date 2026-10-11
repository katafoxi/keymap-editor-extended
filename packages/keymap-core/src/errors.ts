export class KeymapValidationError extends Error {
  errors: string[]

  constructor(errors: string[]) {
    super(errors.join('; '))
    this.name = 'KeymapValidationError'
    this.errors = errors
  }
}

export class InfoValidationError extends Error {
  errors: string[]
  /** Repo-relative file when the failure is not `config/info.json`. */
  readonly path?: string

  constructor(errors: string[], path?: string) {
    super(errors.join('; '))
    this.name = 'InfoValidationError'
    this.errors = errors
    this.path = path
  }
}
