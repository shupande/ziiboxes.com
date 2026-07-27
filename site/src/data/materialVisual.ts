const materialVisuals: [RegExp, string][] = [
  [/white corrugated/i, "/images/guides/supplier-ecommerce-mailer-boxes.jpg"],
  [/kraft/i, "/images/guides/supplier-cardboard-soap-packaging.jpg"],
  [/e-flute|b-flute|corrugated/i, "/images/products/custom-shipping-boxes.jpg"],
  [/inside print/i, "/images/guides/supplier-mailer-gift-boxes.jpg"],
  [/insert|foam|eva|tray/i, "/images/products/custom-paper-inserts.jpg"],
  [/foil|metallic/i, "/images/products/luxury-wine-boxes.jpg"],
  [/emboss|deboss/i, "/images/rigid-boxes.jpg"],
  [/pantone|cmyk|color|print/i, "/images/mailer-boxes.jpg"],
  [/window/i, "/images/products/custom-window-boxes.jpg"],
  [/lamination|matte|gloss|soft.touch|spot uv/i, "/images/products/custom-rigid-boxes.jpg"],
  [/paperboard|card paper|duplex/i, "/images/products/custom-folding-cartons.jpg"],
];

export function materialVisual(label: string) {
  return materialVisuals.find(([pattern]) => pattern.test(label))?.[1]
    ?? "/images/products/custom-rigid-boxes.jpg";
}
