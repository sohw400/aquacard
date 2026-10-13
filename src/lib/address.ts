import type { ShippingAddress } from './types';

/** Made-up road names, so the demo never stores a real home address. A launch would search the road-name address API instead. */
export const SAMPLE_ADDRESSES: readonly Omit<ShippingAddress, 'detail'>[] = [
  { zip: '04500', road: '서울특별시 중구 아쿠아로 1' },
  { zip: '06100', road: '서울특별시 강남구 아쿠아로 25' },
  { zip: '03900', road: '서울특별시 마포구 물결로 8' },
  { zip: '13500', road: '경기도 성남시 분당구 물결로 12' },
  { zip: '34000', road: '대전광역시 유성구 샘물로 15' },
  { zip: '48000', road: '부산광역시 해운대구 바다로 7' },
  { zip: '61000', road: '광주광역시 서구 물빛로 3' },
];

export function searchAddresses(query: string): readonly Omit<ShippingAddress, 'detail'>[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return SAMPLE_ADDRESSES;
  return SAMPLE_ADDRESSES.filter((item) => words.every((word) => item.road.includes(word) || item.zip.startsWith(word)));
}

export function validAddress(value: unknown): value is ShippingAddress {
  if (typeof value !== 'object' || value === null) return false;
  const { zip, road, detail } = value as Record<string, unknown>;
  return typeof zip === 'string' && /^\d{5}$/.test(zip) && typeof road === 'string' && road.trim().length >= 5 && road.length <= 100
    && typeof detail === 'string' && detail.length <= 60;
}

export const addressLine = (address: ShippingAddress) => `${address.road}${address.detail.trim() ? `, ${address.detail.trim()}` : ''}`;
