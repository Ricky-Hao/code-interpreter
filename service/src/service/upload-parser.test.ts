import { expect, test } from 'bun:test';
import { createUploadParser } from './upload-parser';

test('decodes multipart filenames as UTF-8', async () => {
    const boundary = 'codeapi-utf8-boundary';
    const filename = '中文测试文件.txt';
    const body = Buffer.from(
        [
            `--${boundary}`,
            `Content-Disposition: form-data; name="files"; filename="${filename}"`,
            'Content-Type: text/plain',
            '',
            'UTF8_CONTENT_OK',
            `--${boundary}--`,
            '',
        ].join('\r\n')
    );

    const parsedFilename = await new Promise<string>((resolve, reject) => {
        const parser = createUploadParser({
            headers: {
                'content-type': `multipart/form-data; boundary=${boundary}`,
            },
        });
        parser.on('file', (_fieldname, stream, info) => {
            stream.resume();
            resolve(info.filename);
        });
        parser.on('error', reject);
        parser.end(body);
    });

    expect(parsedFilename).toBe(filename);
});