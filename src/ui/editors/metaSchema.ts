/**
 * A compact JSON Schema meta-schema used to drive Monaco's JSON completion, hover and validation
 * for the schema editors. Written by hand (rather than shipping draft-07 verbatim) so every keyword
 * carries documentation and the useful snippets, and so `$ref` can suggest the named types.
 */
const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

export function buildMetaSchema(typeNames: string[]): Record<string, unknown> {
  const typeValue = {
    anyOf: [{ enum: TYPES }, { type: 'array', items: { enum: TYPES }, uniqueItems: true }],
    markdownDescription:
      'The JSON type of the value: `string`, `number`, `integer`, `boolean`, `object`, `array` or `null`. An array of types means "any of these".',
  }
  const schemaMap = (description: string) => ({
    type: 'object',
    additionalProperties: { $ref: '#' },
    markdownDescription: description,
  })
  const num = (description: string) => ({ type: 'number', markdownDescription: description })
  const int = (description: string) => ({ type: 'integer', minimum: 0, markdownDescription: description })

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: ['object', 'boolean'],
    defaultSnippets: [
      { label: 'string', body: { type: 'string' } },
      { label: 'number', body: { type: 'number' } },
      { label: 'integer', body: { type: 'integer' } },
      { label: 'boolean', body: { type: 'boolean' } },
      {
        label: 'object',
        description: 'An object with properties',
        body: { type: 'object', properties: { '${1:name}': { type: '${2|string,number,integer,boolean,object,array|}' } }, required: ['${1:name}'] },
      },
      { label: 'array', description: 'An array of items', body: { type: 'array', items: { type: '${1|string,number,integer,boolean,object|}' } } },
      { label: 'nullable', description: 'T or null', body: { anyOf: [{ type: '${1|string,number,integer,boolean,object,array|}' }, { type: 'null' }] } },
      { label: 'enum', description: 'One of a fixed set of values', body: { enum: ['${1:a}', '${2:b}'] } },
      { label: 'reference', description: 'Use a named type', body: { $ref: '${1}' } },
    ],
    properties: {
      $schema: { type: 'string', markdownDescription: 'The JSON Schema dialect.' },
      $id: { type: 'string', markdownDescription: 'Identifier of this schema.' },
      $ref: {
        type: 'string',
        examples: typeNames,
        markdownDescription:
          'Reference to a **named type** from the left panel (`"Order"`), or to a local definition (`"#/$defs/Name"`).',
      },
      $defs: schemaMap('Reusable local definitions, referenced as `#/$defs/Name`.'),
      definitions: schemaMap('Reusable local definitions (older spelling of `$defs`).'),
      title: { type: 'string', markdownDescription: 'A short label.' },
      description: { type: 'string', markdownDescription: 'Human readable description.' },
      default: { markdownDescription: 'A default value.' },
      examples: { type: 'array', markdownDescription: 'Example values.' },
      type: typeValue,
      enum: { type: 'array', markdownDescription: 'The value must be one of these.' },
      const: { markdownDescription: 'The value must be exactly this.' },
      nullable: { type: 'boolean', markdownDescription: 'OpenAPI style: also allow `null`.' },

      properties: {
        ...schemaMap('The properties of an object, each with its own schema.'),
        defaultSnippets: [
          { label: 'property', body: { '${1:name}': { type: '${2|string,number,integer,boolean,object,array|}' } } },
        ],
      },
      required: {
        type: 'array',
        items: { type: 'string' },
        uniqueItems: true,
        markdownDescription: 'Names of the properties that must be present.',
      },
      additionalProperties: {
        $ref: '#',
        markdownDescription:
          '`false` forbids unknown keys, `true` allows any, a schema constrains their values. When omitted, unknown keys are flagged by the dry-run.',
      },
      patternProperties: schemaMap('Schemas for keys matching a regular expression.'),
      minProperties: int('Minimum number of properties.'),
      maxProperties: int('Maximum number of properties.'),

      items: { $ref: '#', markdownDescription: 'The schema of every array item.' },
      prefixItems: { type: 'array', items: { $ref: '#' }, markdownDescription: 'Schemas for the first items (a tuple).' },
      minItems: int('Minimum number of items.'),
      maxItems: int('Maximum number of items.'),
      uniqueItems: { type: 'boolean', markdownDescription: 'All items must be different.' },

      minimum: num('Smallest allowed value (inclusive).'),
      maximum: num('Largest allowed value (inclusive).'),
      exclusiveMinimum: num('Smallest allowed value (exclusive).'),
      exclusiveMaximum: num('Largest allowed value (exclusive).'),
      multipleOf: num('The value must be a multiple of this.'),

      minLength: int('Minimum string length.'),
      maxLength: int('Maximum string length.'),
      pattern: { type: 'string', markdownDescription: 'A regular expression the string must match.' },
      format: {
        type: 'string',
        examples: ['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'hostname', 'ipv4', 'ipv6'],
        markdownDescription: 'A semantic format such as `date-time`, `email` or `uuid`.',
      },

      anyOf: { type: 'array', items: { $ref: '#' }, markdownDescription: 'Valid against at least one of these. Use it with `{"type":"null"}` for nullable.' },
      oneOf: { type: 'array', items: { $ref: '#' }, markdownDescription: 'Valid against exactly one of these.' },
      allOf: { type: 'array', items: { $ref: '#' }, markdownDescription: 'Valid against all of these (intersection).' },
      not: { $ref: '#', markdownDescription: 'Must not be valid against this schema.' },
      if: { $ref: '#' },
      then: { $ref: '#' },
      else: { $ref: '#' },
    },
  }
}
