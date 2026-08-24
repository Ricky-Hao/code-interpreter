import busboy from 'busboy';

type BusboyConfig = Parameters<typeof busboy>[0];

export function createUploadParser(
    config: BusboyConfig
): ReturnType<typeof busboy> {
    return busboy({
        ...config,
        defParamCharset: 'utf8',
    });
}