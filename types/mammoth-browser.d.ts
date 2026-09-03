declare module 'mammoth/mammoth.browser.js' {
  interface ConvertResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  interface ConvertInput {
    arrayBuffer: ArrayBuffer;
  }
  export function convertToHtml(input: ConvertInput): Promise<ConvertResult>;
  const mammoth: {
    convertToHtml: (input: ConvertInput) => Promise<ConvertResult>;
  };
  export default mammoth;
}

declare module 'mammoth/mammoth.browser' {
  export * from 'mammoth/mammoth.browser.js';
  export { default } from 'mammoth/mammoth.browser.js';
}
