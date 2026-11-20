import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { NodeDomainDnsVerifier } from '../../worker/src/domain-dns';
/** A disposable authoritative DNS fixture. No test queries leave loopback. */
export async function startDomainDnsFixture() {
  const socket = createSocket('udp4');
  const records = new Map<string, { address?: string; txt?: string }>();
  socket.on('message', (query, peer) => {
    if (query.length < 17) return;
    let offset = 12;
    const labels: string[] = [];
    while (offset < query.length && query[offset] !== 0) {
      const size = query[offset++]!;
      if (size > 63 || offset + size >= query.length) return;
      labels.push(query.subarray(offset, offset + size).toString('ascii')); offset += size;
    }
    if (offset + 5 > query.length) return;
    const questionEnd = offset + 5, type = query.readUInt16BE(offset + 1);
    const record = records.get(labels.join('.'));
    let value: Buffer | undefined;
    if (type === 1 && record?.address) value = Buffer.from(record.address.split('.').map(Number));
    if (type === 16 && record?.txt) { const txt = Buffer.from(record.txt); value = Buffer.concat([Buffer.from([txt.length]), txt]); }
    const header = Buffer.alloc(12); query.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4);
    header.writeUInt16BE(value ? 1 : 0, 6);
    const answer = Buffer.alloc(12); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(type, 2); answer.writeUInt16BE(1, 4);
    if (value) answer.writeUInt16BE(value.length, 10);
    socket.send(Buffer.concat([header, query.subarray(12, questionEnd), ...(value ? [answer, value] : [])]), peer.port, peer.address);
  });
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  const address = socket.address();
  return { records, verifier: new NodeDomainDnsVerifier(() => { const resolver = new Resolver({ timeout: 500, tries: 1 }); resolver.setServers(['127.0.0.1:' + address.port]); return resolver; }),
    close: () => new Promise<void>(resolve => socket.close(() => resolve())) };
}
