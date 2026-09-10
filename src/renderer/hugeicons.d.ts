declare module '@hugeicons/core-free-icons/*' {
  type HugeIconNode = readonly [tag: string, attrs: Readonly<Record<string, string | number>>];
  const icon: readonly HugeIconNode[];
  export default icon;
}
