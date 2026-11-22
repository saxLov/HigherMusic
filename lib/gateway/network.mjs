import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { withPlatformDeadline } from './transport.mjs';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]])
  blocked.addSubnet(address, prefix, 'ipv6');
const publicIPv6 = new BlockList();
publicIPv6.addSubnet('2000::', 3, 'ipv6');

export function isPublicHostname(host) {
  return typeof host === 'string' && !isIP(host) && host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) &&
    !/\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/i.test(host);
}

const isPublicAddress = ({ address, family }) => family === 4
  ? !blocked.check(address)
  : family === 6 && publicIPv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');

export function publicLookup(host, options, callback) {
  lookup(host, { all: true, family: options.family }, (error, records) => {
    if (error) return callback(error);
    // The socket uses these exact addresses, with the original hostname retained for TLS.
    const allowed = records.filter(isPublicAddress);
    if (!allowed.length) return callback(new Error('CDN has no public address'));
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

export async function checkPublicDns(host, signal) {
  const records = await withPlatformDeadline(() => new Promise((resolve, reject) =>
    lookup(host, { all: true }, (error, values) => error ? reject(error) : resolve(values))), 2000, signal);
  if (!records.length || !records.every(isPublicAddress)) throw new Error('CDN DNS check failed');
}

