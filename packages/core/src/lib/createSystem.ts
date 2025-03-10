import pLimit from 'p-limit';
import { FieldData, KeystoneConfig, getGqlNames } from '../types';

import { createAdminMeta } from '../admin-ui/system/createAdminMeta';
import { PrismaModule } from '../artifacts';
import { allowAll } from '../access';
import { createGraphQLSchema } from './createGraphQLSchema';
import { makeCreateContext } from './context/createContext';
import { initialiseLists } from './core/types-for-lists';
import { setPrismaNamespace, setWriteLimit } from './core/utils';

function getSudoGraphQLSchema(config: KeystoneConfig) {
  // This function creates a GraphQLSchema based on a modified version of the provided config.
  // The modifications are:
  //  * All list level access control is disabled
  //  * All field level access control is disabled
  //  * All graphql.omit configuration is disabled
  //  * All fields are explicitly made filterable and orderable
  //
  // These changes result in a schema without any restrictions on the CRUD
  // operations that can be run.
  //
  // The resulting schema is used as the GraphQL schema when calling `context.sudo()`.
  const transformedConfig: KeystoneConfig = {
    ...config,
    ui: {
      ...config.ui,
      isAccessAllowed: allowAll,
    },
    lists: Object.fromEntries(
      Object.entries(config.lists).map(([listKey, list]) => {
        return [
          listKey,
          {
            ...list,
            access: allowAll,
            graphql: { ...(list.graphql || {}), omit: {} },
            fields: Object.fromEntries(
              Object.entries(list.fields).map(([fieldKey, field]) => {
                if (fieldKey.startsWith('__group')) return [fieldKey, field];
                return [
                  fieldKey,
                  (data: FieldData) => {
                    const f = field(data);
                    return {
                      ...f,
                      access: allowAll,
                      isFilterable: true,
                      isOrderable: true,
                      graphql: { ...(f.graphql || {}), omit: {} },
                    };
                  },
                ];
              })
            ),
          },
        ];
      })
    ),
  };

  const lists = initialiseLists(transformedConfig);
  const adminMeta = createAdminMeta(transformedConfig, lists);
  return createGraphQLSchema(transformedConfig, lists, adminMeta, true);
}

export function createSystem(config: KeystoneConfig) {
  const lists = initialiseLists(config);
  const adminMeta = createAdminMeta(config, lists);
  const graphQLSchema = createGraphQLSchema(config, lists, adminMeta, false);
  const sudoGraphQLSchema = getSudoGraphQLSchema(config);

  return {
    graphQLSchema,
    adminMeta,
    getKeystone: (prismaModule: PrismaModule) => {
      const prismaClient = new prismaModule.PrismaClient({
        log:
          config.db.enableLogging === true
            ? ['query']
            : config.db.enableLogging === false
            ? undefined
            : config.db.enableLogging,
        datasources: { [config.db.provider]: { url: config.db.url } },
      });

      setWriteLimit(prismaClient, pLimit(config.db.provider === 'sqlite' ? 1 : Infinity));
      setPrismaNamespace(prismaClient, prismaModule.Prisma);

      const context = makeCreateContext({
        graphQLSchema,
        sudoGraphQLSchema,
        config,
        prismaClient,
        gqlNamesByList: Object.fromEntries(
          Object.entries(lists).map(([listKey, list]) => [listKey, getGqlNames(list)])
        ),
        lists,
      });

      return {
        // TODO: remove, replace with server.onStart
        async connect() {
          await prismaClient.$connect();
          await config.db.onConnect?.(context);
        },
        // TODO: remove, only used by tests
        async disconnect() {
          await prismaClient.$disconnect();
        },
        context,
      };
    },
  };
}
