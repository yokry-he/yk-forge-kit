// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { compileStyle, parse } from 'vue/compiler-sfc';
import BuildFailureDiagnosis from '../src/components/builds/BuildFailureDiagnosis.vue';
import diagnosisSource from '../src/components/builds/BuildFailureDiagnosis.vue?raw';
import globalStyles from '../src/style.css?raw';
import { buildDiagnosisCopy, diagnosisCopy } from '../src/components/builds/build-diagnosis-copy';

enableAutoUnmount(afterEach);
describe('build failure diagnosis card', () => {
  it.each([false, true])('keeps heading, evidence, steps and button readable with global panel styles (dark=%s)', dark => {
    const wrapper = mount(BuildFailureDiagnosis, { attachTo: document.body, props: { build: {
      status: 'failed', diagnosis: { category: 'compile_error', matchedLogSeqs: [1], excerpt: ['error TS2322'] },
    } } });
    const scopeId = wrapper.element.getAttributeNames().find(name => name.startsWith('data-v-'))!;
    const source = parse(diagnosisSource).descriptor.styles[0]!.content;
    const compiled = compileStyle({ source, id: scopeId, scoped: true });
    expect(compiled.errors).toEqual([]);
    const stylesheet = document.createElement('style');
    stylesheet.textContent = `${globalStyles}\n${compiled.code}`;
    document.head.append(stylesheet);
    const wasDark = document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    try {
      const card = getComputedStyle(wrapper.element);
      expect(card.getPropertyValue('--diagnosis-text').trim()).toBe(dark ? '#e4e4e7' : '#18181b');
      expect(card.getPropertyValue('--diagnosis-muted').trim()).toBe(dark ? '#c4c4cc' : '#3f3f46');
      expect(card.getPropertyValue('--diagnosis-bg').trim()).toBe(dark ? '#18181b' : '#fafafa');
      // jsdom preserves var() references; assert the cascade selects the card's theme tokens.
      for (const selector of ['h2', 'li', 'pre', 'button']) {
        expect(getComputedStyle(wrapper.get(selector).element).color).toBe('var(--diagnosis-text)');
      }
      expect(getComputedStyle(wrapper.get('p').element).color).toBe('var(--diagnosis-muted)');
      expect(getComputedStyle(wrapper.get('button').element).background).toBe('var(--diagnosis-bg)');
    } finally {
      stylesheet.remove();
      document.documentElement.classList.toggle('dark', wasDark);
    }
  });
  it('explains a known failure, renders escaped evidence and navigates by stored sequence', async () => {
    const wrapper = mount(BuildFailureDiagnosis, { props: { build: { status: 'failed', diagnosis: {
      category: 'compile_error', matchedLogSeqs: [42], excerpt: ['error TS2322: <script>example</script>'],
    } } } });
    expect(wrapper.classes()).toContain('build-detail-card');
    expect(wrapper.get('h2').text()).toBe('失败诊断：代码编译错误');
    expect(wrapper.findAll('li')).toHaveLength(3);
    expect(wrapper.get('pre').text()).toContain('<script>');
    expect(wrapper.find('script').exists()).toBe(false);
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('viewLogs')).toEqual([[[42]]]);
  });
  it.each([null, { category: 'unknown' as const, matchedLogSeqs: [], excerpt: [] }])('falls back for old or unknown diagnosis %s', async diagnosis => {
    const wrapper = mount(BuildFailureDiagnosis, { props: { build: { status: 'failed', diagnosis } } });
    expect(wrapper.text()).toContain('暂未识别失败原因');
    expect(wrapper.get('button').text()).toBe('查看完整日志');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('viewLogs')).toEqual([[[]]]);
    expect(diagnosisCopy('future_category')).toBe(buildDiagnosisCopy.unknown);
  });
  it.each(['succeeded', 'queued', 'running', 'canceled'] as const)('does not show for %s', status => {
    const wrapper = mount(BuildFailureDiagnosis, { props: { build: { status, diagnosis: null } } });
    expect(wrapper.find('section').exists()).toBe(false);
  });
  it('explains timed out builds and every category offers two to four actions', () => {
    const wrapper = mount(BuildFailureDiagnosis, { props: { build: { status: 'timed_out', diagnosis: {
      category: 'timeout', matchedLogSeqs: [], excerpt: [],
    } } } });
    expect(wrapper.text()).toContain('构建超时');
    for (const copy of Object.values(buildDiagnosisCopy)) {
      expect(copy.steps.length).toBeGreaterThanOrEqual(2);
      expect(copy.steps.length).toBeLessThanOrEqual(4);
    }
  });
});
