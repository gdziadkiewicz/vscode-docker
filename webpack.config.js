/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

// Full webpack documentation: [https://webpack.js.org/configuration/]().
// In short, the config-files defines the entrypoint of the extension, to use TypeScript, to produce a commonjs-module, and what modules not to bundle.
// Using webpack helps reduce the install- and startup-time of large extensions because instead of hundreds of files, a single file is produced.

'use strict';

const path = require('path');
const webpack = require('webpack');
const fse = require('fs-extra');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CleanWebpackPlugin = require('clean-webpack-plugin');
const StringReplacePlugin = require("string-replace-webpack-plugin");

const packageLock = fse.readJSONSync('./package-lock.json');

const externalModules = [
    // Modules that we can't webpack for some reason.
    // Keep this list small, because all the subdependencies will also have to not be webpacked.
    'clipboardy',
    'win-ca' // has binary
];
// External modules and all their dependencies and subdependencies (these will not be webpacked)
const externalModulesClosure = getDependencies(externalModules);
console.log('externalModulesClosure:', externalModulesClosure);

/**@type {import('webpack').Configuration}*/
const config = {
    // vscode extensions run in a Node.js context, see https://webpack.js.org/configuration/node/
    target: 'node',
    context: __dirname,
    node: {
        // For __dirname and __filename, use the path to the packed .js file (true would mean the relative path to the source file)
        __dirname: false,
        __filename: false
    },
    entry: {
        // The entrypoint of this extension, see https://webpack.js.org/configuration/entry-context/
        extension: './extension.ts', // asdf

        // Entrypoint for the language server
        './dockerfile-language-server-nodejs/lib/server': './node_modules/dockerfile-language-server-nodejs/lib/server.js',

        // // Entrypoint for tests
        // tests: './test/index.ts'
    },
    output: {
        // The bundles are stored in the 'dist' folder (check package.json), see https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]"
    },
    devtool: 'source-map',
    externals: [
        {
            // Modules that cannot be webpack'ed, see https://webpack.js.org/configuration/externals/

            // the vscode-module is created on-the-fly and must be excluded.
            vscode: 'commonjs vscode',

            // Out util/getCoreNodeModule.js file uses a dynamic require, so we'll just use it directly as a .js file.
            // Note that the source is in .js and not .ts because we don't want webpack to depend on npm run build
            // (except currently it's required for tests)
            './getCoreNodeModule': 'commonjs getCoreNodeModule',

            // Pull the rest automatically from externalModulesClosure
            ...getExternalsEntries()
        }
    ],
    plugins: [
        // Clean the dist folder before webpacking
        new CleanWebpackPlugin(
            ['dist'],
            {
                root: __dirname,
                verbose: true,
            }),

        new CopyWebpackPlugin([
            { from: './utils/getCoreNodeModule.js', to: 'node_modules' },
        ]),

        // Automatically copy all external node modules
        getExternalsCopyEntry(),

        new CopyWebpackPlugin([
            // Images
            { from: './images', to: 'images' },

            // Test files
            { from: './out/test', to: 'test' }
        ]),

        // vscode-languageserver/lib/files.js has one function which uses a dynamic require, but is not currently used by any dependencies
        // Replace with a version that has only what is actually used.
        new webpack.NormalModuleReplacementPlugin(
            /[/\\]vscode-languageserver[/\\]lib[/\\]files\.js/,
            require.resolve('./build/vscode-languageserver-files-stub.js')
        ),

        // Solve critical dependency issue in ./node_modules/ms-rest/lib/serviceClient.js (request of a dependency is an expression)
        // for this line:
        //
        //   let data = require(packageJsonPath);
        //
        new webpack.ContextReplacementPlugin(
            // Whenever there is a dynamic require that webpack can't analyze at all (i.e. resourceRegExp=/^\./), ...
            /^\./,
            (context) => {
                // ... and the call was from within node_modules/ms-rest/lib...
                if (/node_modules[/\\]ms-rest[/\\]lib/.test(context.context)) {
                    // CONSIDER: Figure out how to make this work properly. The consequences of ignoring this error are that
                    // the Azure SDKs (e.g. azure-arm-resource) don't get their info stamped into the user agent info for their calls.

                    // // ... tell webpack that the call may be loading any of the package.json files from the 'node_modules/azure-arm*' folders
                    // // so it will include those in the package to be available for lookup at runtime
                    // context.request = path.resolve(__dirname, 'node_modules');
                    // context.regExp = /azure-arm.*package\.json/;

                    // Tell webpack we've solved the critical dependency issue
                    for (const d of context.dependencies) {
                        if (d.critical) { d.critical = false; }
                    }
                }
            }),

        // an instance of the plugin must be present
        new StringReplacePlugin()
    ],
    resolve: {
        // Support reading TypeScript and JavaScript files, see https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{
                    // Note: the TS loader will transpile the .ts file directly during webpack, it doesn't use the out folder.
                    // CONSIDER: awesome-typescript-loader (faster?)
                    loader: 'ts-loader'
                }]
            },

            {
                // Unpack UMD module headers used in some modules since webpack doesn't
                // handle them.
                test: /dockerfile-language-service|vscode-languageserver-types/,
                use: { loader: 'umd-compat-loader' }
            },

            // Note: If you use`vscode-nls` to localize your extension than you likely also use`vscode-nls-dev` to create language bundles at build time.
            // To support webpack, a loader has been added to vscode-nls-dev .Add the section below to the`modules/rules` configuration.
            // {
            //     // vscode-nls-dev loader:
            //     // * rewrite nls-calls
            //     loader: 'vscode-nls-dev/lib/webpack-loader',
            //     options: {
            //         base: path.join(__dirname, 'src')
            //     }
            // }

            {
                // Fix error in win-ca: Module parse failed: 'return' outside of function (5:2)
                //
                // if (process.platform !== 'win32') {
                //    return;  <<<<<<<<<<
                // }
                test: /win-ca[/\\]lib[/\\]index.js$/,
                loader: StringReplacePlugin.replace({
                    replacements: [
                        {
                            pattern: /return;/ig,
                            replacement: function (match, offset, string) {
                                return `// Don't need platform check - we do that before calling the module`;
                            }
                        }
                    ]
                })
            },
            {
                // Fix error in mac-ca: Module parse failed: 'return' outside of function (7:2)
                //
                // if (process.platform !== 'darwin') {
                //     module.exports.all = () => [];
                //     module.exports.each = () => {};
                //     return;  <<<<<<<<<
                //   }
                test: /mac-ca[/\\]index.js$/,
                loader: StringReplacePlugin.replace({
                    replacements: [
                        {
                            pattern: /return;/ig,
                            replacement: function (match, offset, string) {
                                return `// Don't need platform check - we do that before calling the module`;
                            }
                        }
                    ]
                })
            }
        ]
    }
    // optimization: {
    //     splitChunks: {
    //         minChunks: 1,
    //         minSize: 1,
    //         chunks: "all",
    //         cacheGroups: {
    //             commons: {
    //                 test: /[\\/]node_modules[\\/]/,
    //                 name: 'nodeModules-chunk',
    //                 chunks: 'initial'
    //             },
    //             'entry': {
    //                 test: /entry/,
    //                 priority: 100,
    //                 name: 'entry'
    //             },
    //             'tests': {
    //                 test: /test/,
    //                 priority: 0,
    //                 name: 'tests',
    //                 chunks: "all"
    //             }

    //         }
    //     }
}

// optimization: {
//     runtimeChunk: "single",
//     splitChunks: {
//         //chunks: "async",
//         minChunks: 1,
//         minSize: 1,
//         cacheGroups: {
//             commons: {
//                 test: /[\\/]node_modules[\\/]/,
//                 name: 'nodeModules-chunk',
//                 chunks: 'initial'
//             },
//             extensionVars: {
//                 test: /extensionVar/,
//                 name: 'extensionVars',
//                 chunks: 'all'
//             }
//         }
//     },
// }


function getExternalsEntries() {
    let externals = {};
    for (let moduleName of externalModulesClosure) {
        // e.g.
        // '<clipboardy>': 'commonjs <clipboardy>',
        externals[moduleName] = `commonjs ${moduleName}`;
    }

    return externals;
}

function getExternalsCopyEntry() {
    // e.g.
    // new CopyWebpackPlugin([
    //     { from: './node_modules/clipboardy', to: 'node_modules/clipboardy' }
    //     ...
    // ])

    let patterns = [];
    for (let moduleName of externalModulesClosure) {
        patterns.push({
            from: `./node_modules/${moduleName}`,
            to: `node_modules/${moduleName}`
        });
    }

    return new CopyWebpackPlugin(patterns);
}

function getDependencies(modules) {
    let set = new Set();

    for (let module of modules) {
        set.add(module);
        let depEntry = packageLock.dependencies[module];
        if (!depEntry) {
            throw new Error(`Could not find package-lock entry for ${module}`);
        }

        if (depEntry.requires) {
            let requiredModules = Object.getOwnPropertyNames(depEntry.requires);
            let subdeps = getDependencies(requiredModules);
            for (let subdep of subdeps) {
                set.add(subdep);
            }
        }
    }

    return Array.from(set);
}

//console.log('Config:', config);
module.exports = config;
