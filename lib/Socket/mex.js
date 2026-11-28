import { Boom } from '@hapi/boom';
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary/index.js';
import { decodeMexArgoResponse, resolveMexArgoWireType } from '../Utils/mex-argo/index.js';
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: S_WHATSAPP_NET,
            xmlns: 'w:mex'
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: queryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
            }
        ]
    });
};
const decodeArgoResult = (content, opName) => {
    const wire = resolveMexArgoWireType(opName);
    if (!wire) {
        throw new Boom(`mex/${opName} argo response has no known wire type; register one with registerMexArgoWireType('${opName}', ...)`, { statusCode: 400 });
    }
    const bytes = typeof content === 'string' ? Buffer.from(content, 'binary') : content;
    return decodeMexArgoResponse(bytes, wire);
};
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag, opName) => {
    const result = await wMexQuery(variables, queryId, query, generateMessageTag);
    const child = getBinaryNodeChild(result, 'result');
    if (child?.content) {
        // format="argo" responses are binary; decode with the wire type registered for `opName`
        const data = child.attrs?.format === 'argo'
            ? decodeArgoResult(child.content, opName || dataPath)
            : JSON.parse(child.content.toString());
        if (data.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map((err) => err.message || 'Unknown error').join(', ');
            const firstError = data.errors[0];
            const errorCode = firstError.extensions?.error_code || 400;
            throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError });
        }
        let response = dataPath ? data?.data?.[dataPath] : data?.data;
        if (typeof response === 'undefined' && dataPath && data?.data) {
            const keys = Object.keys(data.data);
            if (keys.length === 1) {
                response = data.data[keys[0]];
            }
        }
        if (typeof response !== 'undefined') {
            return response;
        }
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ');
    throw new Boom(`Failed to ${action}, unexpected response structure: ${JSON.stringify(result, null, 2)}`, { statusCode: 400, data: result });
};
//# sourceMappingURL=mex.js.map