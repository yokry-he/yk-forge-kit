import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseCreateProject } from '../src/projects.controller';

describe('HTTP project payload validation', () => {
  it('normalizes feature order', () => {
    expect(parseCreateProject({ name: 'new-app', template: 'vue-web', features: ['pinia', 'theme'] }))
      .toEqual({ name: 'new-app', template: 'vue-web', features: ['theme', 'pinia'] });
  });

  it.each([null, [], {}, { name: '../evil', template: 'vue-web', features: [] },
    { name: 'valid', template: 'vue-web', features: ['unknown'] },
    { name: 'valid', template: 'vue-web', features: [null] },
  ])('rejects invalid input: %j', (value) => {
    expect(() => parseCreateProject(value)).toThrow(BadRequestException);
  });
});
