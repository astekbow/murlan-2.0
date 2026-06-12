import { test, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AvatarFace } from './AvatarFace.tsx';

test('renders the preset emoji for a preset avatar id', () => {
  const { container } = render(<AvatarFace id="spade" />);
  expect(container.textContent).toContain('♠');
});

test('renders an <img> for an uploaded data-URL avatar', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/abc';
  const { container } = render(<AvatarFace id={dataUrl} size={40} />);
  const img = container.querySelector('img');
  expect(img).toBeTruthy();
  expect(img?.getAttribute('src')).toBe(dataUrl);
});

test('falls back to the default face for a null avatar', () => {
  const { container } = render(<AvatarFace id={null} />);
  expect(container.textContent).toContain('🎴');
});
