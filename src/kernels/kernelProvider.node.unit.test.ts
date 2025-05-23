// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import {
    CancellationToken,
    CancellationTokenSource,
    EventEmitter,
    Memento,
    NotebookController,
    NotebookDocument,
    Uri
} from 'vscode';
import {
    IConfigurationService,
    IDisposable,
    IExtensionContext,
    IWatchableJupyterSettings
} from '../platform/common/types';
import { createEventHandler } from '../test/common';
import { createKernelController, TestNotebookDocument } from '../test/datascience/notebook/executionHelper';
import { IJupyterServerUriStorage } from './jupyter/types';
import { KernelProvider, ThirdPartyKernelProvider } from './kernelProvider.node';
import { Kernel, ThirdPartyKernel } from './kernel';
import {
    IKernelSessionFactory,
    IKernelController,
    IKernelProvider,
    IStartupCodeProviders,
    IThirdPartyKernelProvider,
    KernelConnectionMetadata,
    KernelOptions
} from './types';
import { dispose } from '../platform/common/utils/lifecycle';
import { noop } from '../test/core';
import { AsyncDisposableRegistry } from '../platform/common/asyncDisposableRegistry';
import { JupyterNotebookView } from '../platform/common/constants';
import { mockedVSCodeNamespaces } from '../test/vscode-mock';
import { CellOutputDisplayIdTracker } from './execution/cellDisplayIdTracker';
import { IReplNotebookTrackerService } from '../platform/notebooks/replNotebookTrackerService';
import { AsyncEmitter } from '../platform/common/utils/events';
import { KernelWorkingDirectory } from './raw/session/kernelWorkingDirectory.node';
import { FileSystem } from '../platform/common/platform/fileSystem.node';
import { IRawNotebookSupportedService } from './raw/types';

suite('Jupyter Session', () => {
    suite('Node Kernel Provider', function () {
        let disposables: IDisposable[] = [];
        const asyncDisposables: { dispose: () => Promise<unknown> }[] = [];
        let sessionCreator: IKernelSessionFactory;
        let configService: IConfigurationService;
        let context: IExtensionContext;
        let jupyterServerUriStorage: IJupyterServerUriStorage;
        let metadata: KernelConnectionMetadata;
        let controller: IKernelController;
        let rawkernelSupported: IRawNotebookSupportedService;
        let workspaceMemento: Memento;
        const replTracker: IReplNotebookTrackerService = mock<IReplNotebookTrackerService>();
        setup(() => {
            sessionCreator = mock<IKernelSessionFactory>();
            configService = mock<IConfigurationService>();
            context = mock<IExtensionContext>();
            jupyterServerUriStorage = mock<IJupyterServerUriStorage>();
            metadata = mock<KernelConnectionMetadata>();
            controller = createKernelController();
            workspaceMemento = mock<Memento>();
            rawkernelSupported = mock<IRawNotebookSupportedService>();
            when(workspaceMemento.update(anything(), anything())).thenResolve();
            when(workspaceMemento.get(anything(), anything())).thenCall(
                (_: unknown, defaultValue: unknown) => defaultValue
            );
            when(rawkernelSupported.isSupported).thenReturn(true);
        });
        function createKernelProvider() {
            const registry = mock<IStartupCodeProviders>();
            when(registry.getProviders(anything())).thenReturn([]);
            return new KernelProvider(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                asyncDisposables as any,
                disposables,
                instance(sessionCreator),
                instance(configService),
                instance(context),
                instance(jupyterServerUriStorage),
                [],
                instance(registry),
                instance(workspaceMemento),
                instance(replTracker),
                new KernelWorkingDirectory(instance(configService), new FileSystem()),
                instance(rawkernelSupported)
            );
        }
        function create3rdPartyKernelProvider() {
            const registry = mock<IStartupCodeProviders>();
            when(registry.getProviders(anything())).thenReturn([]);
            return new ThirdPartyKernelProvider(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                asyncDisposables as any,
                disposables,
                instance(sessionCreator),
                instance(configService),
                instance(registry),
                instance(workspaceMemento),
                new KernelWorkingDirectory(instance(configService), new FileSystem()),
                instance(rawkernelSupported)
            );
        }
        teardown(async () => {
            sinon.restore();
            disposables = dispose(disposables);
            await Promise.all(asyncDisposables.map((item) => item.dispose().catch(noop)));
            asyncDisposables.length = 0;
        });
        async function testKernelProviderEvents(thirdPartyKernelProvider = false) {
            const kernelProvider = thirdPartyKernelProvider ? create3rdPartyKernelProvider() : createKernelProvider();
            const kernelCreated = createEventHandler(kernelProvider, 'onDidCreateKernel', disposables);
            const kernelStarted = createEventHandler(kernelProvider, 'onDidStartKernel', disposables);
            const kernelDisposed = createEventHandler(kernelProvider, 'onDidDisposeKernel', disposables);
            const kernelRestarted = createEventHandler(kernelProvider, 'onDidRestartKernel', disposables);
            const kernelPostInitialized = createEventHandler(kernelProvider, 'onDidPostInitializeKernel', disposables);
            const kernelStatusChanged = createEventHandler(kernelProvider, 'onKernelStatusChanged', disposables);
            const notebook = new TestNotebookDocument(undefined, 'jupyter-notebook');
            const onStarted = new EventEmitter<void>();
            const onStatusChanged = new EventEmitter<void>();
            const onRestartedEvent = new EventEmitter<void>();
            const onPostInitializedEvent = new AsyncEmitter<{
                token: CancellationToken;
                waitUntil(thenable: Thenable<unknown>): void;
            }>();
            const onDisposedEvent = new EventEmitter<void>();
            disposables.push(onStatusChanged);
            disposables.push(onRestartedEvent);
            disposables.push(onPostInitializedEvent);
            disposables.push(onStarted);
            disposables.push(onDisposedEvent);
            if (kernelProvider instanceof KernelProvider) {
                sinon.stub(Kernel.prototype, 'onStarted').get(() => onStarted.event);
                sinon.stub(Kernel.prototype, 'onStatusChanged').get(() => onStatusChanged.event);
                sinon.stub(Kernel.prototype, 'onRestarted').get(() => onRestartedEvent.event);
                sinon.stub(Kernel.prototype, 'onPostInitialized').get(() => onPostInitializedEvent.event);
                sinon.stub(Kernel.prototype, 'onDisposed').get(() => onDisposedEvent.event);
                const kernel = kernelProvider.getOrCreate(notebook, {
                    controller,
                    metadata: instance(metadata),
                    resourceUri: notebook.uri
                });
                asyncDisposables.push(kernel);
            } else {
                sinon.stub(ThirdPartyKernel.prototype, 'onStarted').get(() => onStarted.event);
                sinon.stub(ThirdPartyKernel.prototype, 'onStatusChanged').get(() => onStatusChanged.event);
                sinon.stub(ThirdPartyKernel.prototype, 'onRestarted').get(() => onRestartedEvent.event);
                sinon.stub(ThirdPartyKernel.prototype, 'onPostInitialized').get(() => onPostInitializedEvent.event);
                sinon.stub(ThirdPartyKernel.prototype, 'onDisposed').get(() => onDisposedEvent.event);
                const kernel = kernelProvider.getOrCreate(notebook.uri, {
                    metadata: instance(metadata),
                    resourceUri: notebook.uri
                });
                asyncDisposables.push(kernel);
            }

            assert.isTrue(kernelCreated.fired, 'IKernelProvider.onDidCreateKernel not fired');
            assert.isFalse(kernelStarted.fired, 'IKernelProvider.onDidStartKernel should not be fired');
            assert.isFalse(kernelStatusChanged.fired, 'IKernelProvider.onKernelStatusChanged should not be fired');
            assert.isFalse(kernelRestarted.fired, 'IKernelProvider.onDidRestartKernel should not have fired');
            assert.isFalse(
                kernelPostInitialized.fired,
                'IKernelProvider.onDidPostInitializeKernel should not have fired'
            );
            assert.isFalse(kernelDisposed.fired, 'IKernelProvider.onDidDisposeKernel should not have fired');

            onStarted.fire();
            assert.isTrue(kernelStarted.fired, 'IKernelProvider.onDidStartKernel not fired');
            onStatusChanged.fire();
            assert.isTrue(kernelStatusChanged.fired, 'IKernelProvider.onKernelStatusChanged not fired');
            onRestartedEvent.fire();
            assert.isTrue(kernelRestarted.fired, 'IKernelProvider.onKernelRestarted not fired');
            await onPostInitializedEvent.fireAsync({}, new CancellationTokenSource().token);
            assert.isTrue(kernelPostInitialized.fired, 'IKernelProvider.onDidPostInitializeKernel not fired');
            onDisposedEvent.fire();
            assert.isTrue(kernelDisposed.fired, 'IKernelProvider.onDisposedEvent not fired');
        }
        test('Kernel Events', async () => await testKernelProviderEvents(false));
        test('3rd Party Kernel Events', async () => await testKernelProviderEvents(true));
    });

    suite('KernelProvider Node', () => {
        let disposables: IDisposable[] = [];
        let asyncDisposables: AsyncDisposableRegistry;
        let kernelProvider: IKernelProvider;
        let thirdPartyKernelProvider: IThirdPartyKernelProvider;
        let sessionCreator: IKernelSessionFactory;
        let configService: IConfigurationService;
        let jupyterServerUriStorage: IJupyterServerUriStorage;
        let context: IExtensionContext;
        let onDidCloseNotebookDocument: EventEmitter<NotebookDocument>;
        const replTracker: IReplNotebookTrackerService = mock<IReplNotebookTrackerService>();
        const sampleUri1 = Uri.file('sample1.ipynb');
        const sampleUri2 = Uri.file('sample2.ipynb');
        const sampleUri3 = Uri.file('sample3.ipynb');
        let sampleNotebook1: NotebookDocument;
        let sampleNotebook2: NotebookDocument;
        let sampleNotebook3: NotebookDocument;
        setup(() => {
            sampleNotebook1 = mock<NotebookDocument>();
            when(sampleNotebook1.uri).thenReturn(sampleUri1);
            when(sampleNotebook1.notebookType).thenReturn(JupyterNotebookView);
            sampleNotebook2 = mock<NotebookDocument>();
            when(sampleNotebook2.uri).thenReturn(sampleUri2);
            when(sampleNotebook2.notebookType).thenReturn(JupyterNotebookView);
            sampleNotebook3 = mock<NotebookDocument>();
            when(sampleNotebook3.uri).thenReturn(sampleUri3);
            when(sampleNotebook3.notebookType).thenReturn(JupyterNotebookView);
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                instance(sampleNotebook1),
                instance(sampleNotebook2),
                instance(sampleNotebook3)
            ]);

            onDidCloseNotebookDocument = new EventEmitter<NotebookDocument>();
            disposables.push(onDidCloseNotebookDocument);
            asyncDisposables = new AsyncDisposableRegistry();
            sessionCreator = mock<IKernelSessionFactory>();
            configService = mock<IConfigurationService>();
            jupyterServerUriStorage = mock<IJupyterServerUriStorage>();
            context = mock<IExtensionContext>();
            const configSettings = mock<IWatchableJupyterSettings>();
            when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(
                onDidCloseNotebookDocument.event
            );
            when(configService.getSettings(anything())).thenReturn(instance(configSettings));
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                instance(sampleNotebook1),
                instance(sampleNotebook2),
                instance(sampleNotebook3)
            ]);
            const registry = mock<IStartupCodeProviders>();
            when(registry.getProviders(anything())).thenReturn([]);
            const workspaceMemento = mock<Memento>();
            when(workspaceMemento.update(anything(), anything())).thenResolve();
            when(workspaceMemento.get(anything(), anything())).thenCall(
                (_: unknown, defaultValue: unknown) => defaultValue
            );
            const kernelWorkingDirectory = new KernelWorkingDirectory(instance(configService), new FileSystem());
            const rawkernelSupported = mock<IRawNotebookSupportedService>();
            when(rawkernelSupported.isSupported).thenReturn(false);
            kernelProvider = new KernelProvider(
                asyncDisposables,
                disposables,
                instance(sessionCreator),
                instance(configService),
                instance(context),
                instance(jupyterServerUriStorage),
                [],
                instance(registry),
                instance(workspaceMemento),
                instance(replTracker),
                kernelWorkingDirectory,
                instance(rawkernelSupported)
            );
            thirdPartyKernelProvider = new ThirdPartyKernelProvider(
                asyncDisposables,
                disposables,
                instance(sessionCreator),
                instance(configService),
                instance(registry),
                instance(workspaceMemento),
                kernelWorkingDirectory,
                instance(rawkernelSupported)
            );
        });
        teardown(async () => {
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
            CellOutputDisplayIdTracker.dispose();
            disposables = dispose(disposables);
            await asyncDisposables.dispose();
        });
        test('Test creation, getting current instance and triggering of events', async () => {
            const metadata = mock<KernelConnectionMetadata>();
            when(metadata.id).thenReturn('xyz');
            const options: KernelOptions = {
                controller: instance(mock<NotebookController>()),
                metadata: instance(metadata),
                resourceUri: sampleUri1
            };

            assert.isUndefined(kernelProvider.get(sampleUri1), 'Should not return an instance');
            assert.isUndefined(kernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(kernelProvider.get(sampleUri3), 'Should not return an instance');

            const onKernelCreated = createEventHandler(kernelProvider, 'onDidCreateKernel', disposables);
            const onKernelDisposed = createEventHandler(kernelProvider, 'onDidDisposeKernel', disposables);
            const kernel = kernelProvider.getOrCreate(instance(sampleNotebook1), options);
            asyncDisposables.push(kernel);

            assert.equal(kernel.uri, sampleUri1, 'Kernel id should match the uri');
            assert.isUndefined(kernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(kernelProvider.get(sampleUri3), 'Should not return an instance');
            assert.equal(onKernelCreated.count, 1, 'Should have triggered the event');
            assert.equal(onKernelDisposed.count, 0, 'Should not have triggered the event');
            assert.isOk(kernel, 'Should be an object');
            assert.equal(kernel, kernelProvider.get(sampleUri1), 'Should return the same instance');
            assert.equal(
                kernel,
                kernelProvider.getOrCreate(instance(sampleNotebook1), options),
                'Should return the same instance'
            );

            await kernel.dispose();
            assert.isTrue(kernel.disposed, 'Kernel should be disposed');
            assert.equal(onKernelDisposed.count, 1, 'Should have triggered the disposed event');
            assert.equal(onKernelDisposed.first, kernel, 'Incorrect disposed event arg');

            assert.isUndefined(kernelProvider.get(sampleUri1), 'Should not return an instance');
            assert.isUndefined(kernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(kernelProvider.get(sampleUri3), 'Should not return an instance');
        });
        test('Test creation of kernels for 3rd party', async () => {
            const metadata = mock<KernelConnectionMetadata>();
            const uri = Uri.file('sample.csv');
            when(metadata.id).thenReturn('xyz');
            const options: KernelOptions = {
                controller: instance(mock<NotebookController>()),
                metadata: instance(metadata),
                resourceUri: uri
            };

            assert.isUndefined(thirdPartyKernelProvider.get(uri), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri1), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri3), 'Should not return an instance');

            const onKernelCreated = createEventHandler(thirdPartyKernelProvider, 'onDidCreateKernel', disposables);
            const onKernelDisposed = createEventHandler(thirdPartyKernelProvider, 'onDidDisposeKernel', disposables);
            const kernel = thirdPartyKernelProvider.getOrCreate(uri, options);
            asyncDisposables.push(kernel);

            assert.equal(kernel.uri, uri, 'Kernel id should match the uri');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri3), 'Should not return an instance');
            assert.equal(onKernelCreated.count, 1, 'Should have triggered the event');
            assert.equal(onKernelDisposed.count, 0, 'Should not have triggered the event');
            assert.isOk(kernel, 'Should be an object');
            assert.equal(kernel, thirdPartyKernelProvider.get(uri), 'Should return the same instance');
            assert.equal(kernel, thirdPartyKernelProvider.getOrCreate(uri, options), 'Should return the same instance');

            await kernel.dispose();
            assert.isTrue(kernel.disposed, 'Kernel should be disposed');
            assert.equal(onKernelDisposed.count, 1, 'Should have triggered the disposed event');
            assert.equal(onKernelDisposed.first, kernel, 'Incorrect disposed event arg');

            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri1), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri2), 'Should not return an instance');
            assert.isUndefined(thirdPartyKernelProvider.get(sampleUri3), 'Should not return an instance');
        });
        test('When kernel is disposed a new kernel should be returned when calling getOrCreate', async () => {
            const metadata = mock<KernelConnectionMetadata>();
            when(metadata.id).thenReturn('xyz');
            const options: KernelOptions = {
                controller: instance(mock<NotebookController>()),
                metadata: instance(metadata),
                resourceUri: sampleUri1
            };

            // Dispose the first kernel
            const kernel = kernelProvider.getOrCreate(instance(sampleNotebook1), options);
            await kernel.dispose();

            assert.isTrue(kernel.disposed, 'Kernel should be disposed');
            assert.isUndefined(kernelProvider.get(sampleUri1), 'Should not return an instance as kernel was disposed');
            const newKernel = kernelProvider.getOrCreate(instance(sampleNotebook1), options);
            asyncDisposables.push(newKernel);
            assert.notEqual(kernel, newKernel, 'Should return a different instance');
        });
        test('Dispose the kernel when the associated notebook document is closed', async () => {
            const metadata = mock<KernelConnectionMetadata>();
            when(metadata.id).thenReturn('xyz');
            const options: KernelOptions = {
                controller: instance(mock<NotebookController>()),
                metadata: instance(metadata),
                resourceUri: sampleUri1
            };

            const kernel = kernelProvider.getOrCreate(instance(sampleNotebook1), options);
            assert.isOk(kernel);
            const onKernelDisposed = createEventHandler(kernelProvider, 'onDidDisposeKernel', disposables);
            assert.isOk(kernelProvider.get(sampleUri1), 'Should return an instance');

            // Close the notebook.
            onDidCloseNotebookDocument.fire(instance(sampleNotebook1));
            assert.isTrue(kernel.disposed, 'Kernel should be disposed');
            await onKernelDisposed.assertFired(100);
            assert.isUndefined(kernelProvider.get(sampleUri1), 'Should not return an instance');

            // Calling getOrCreate again will return a whole new instance.
            const newKernel = kernelProvider.getOrCreate(instance(sampleNotebook1), options);
            asyncDisposables.push(newKernel);
            assert.notEqual(kernel, newKernel, 'Should return a different instance');
        });
    });
});
