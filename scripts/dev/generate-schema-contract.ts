import { writeSchemaContractFile } from '../../src/server/db/schemaContract.js';

const contract = writeSchemaContractFile();
const tableCount = Object.keys(contract.tables).length;

console.log(`[schema:contract] wrote ${tableCount} tables`);
