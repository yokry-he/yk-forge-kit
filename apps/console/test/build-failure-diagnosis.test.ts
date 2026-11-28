// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import BuildFailureDiagnosis from '../src/components/builds/BuildFailureDiagnosis.vue';
import { buildDiagnosisCopy, diagnosisCopy } from '../src/components/builds/build-diagnosis-copy';

enableAutoUnmount(afterEach);
describe('build failure diagnosis card', () => {
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
