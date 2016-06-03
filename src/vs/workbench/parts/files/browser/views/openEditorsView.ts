/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nls = require('vs/nls');
import errors = require('vs/base/common/errors');
import {TPromise} from 'vs/base/common/winjs.base';
import {IAction, IActionRunner} from 'vs/base/common/actions';
import dom = require('vs/base/browser/dom');
import {CollapsibleState} from 'vs/base/browser/ui/splitview/splitview';
import {Tree} from 'vs/base/parts/tree/browser/treeImpl';
import {IContextMenuService} from 'vs/platform/contextview/browser/contextView';
import {IMessageService} from 'vs/platform/message/common/message';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {IEditorGroupService} from 'vs/workbench/services/group/common/groupService';
import {IEventService} from 'vs/platform/event/common/event';
import {IConfigurationService} from 'vs/platform/configuration/common/configuration';
import {IKeybindingService} from 'vs/platform/keybinding/common/keybindingService';
import {EventType as WorkbenchEventType, CompositeEvent} from 'vs/workbench/common/events';
import {SaveAllAction} from 'vs/workbench/parts/files/browser/fileActions';
import {AdaptiveCollapsibleViewletView} from 'vs/workbench/browser/viewlet';
import {ITextFileService, IFilesConfiguration, VIEWLET_ID, AutoSaveMode} from 'vs/workbench/parts/files/common/files';
import {IWorkbenchEditorService} from 'vs/workbench/services/editor/common/editorService';
import {IEditorStacksModel, IStacksModelChangeEvent} from 'vs/workbench/common/editor';
import {Renderer, DataSource, Controller, AccessibilityProvider,  ActionProvider, OpenEditor, DragAndDrop} from 'vs/workbench/parts/files/browser/views/openEditorsViewer';
import {IUntitledEditorService} from 'vs/workbench/services/untitled/common/untitledEditorService';
import {CloseAllEditorsAction} from 'vs/workbench/browser/parts/editor/editorActions';

const $ = dom.emmet;

export class OpenEditorsView extends AdaptiveCollapsibleViewletView {

	private static MEMENTO_COLLAPSED = 'openEditors.memento.collapsed';
	private static DEFAULT_VISIBLE_OPEN_EDITORS = 9;
	private static DEFAULT_DYNAMIC_HEIGHT = true;

	private settings: any;
	private visibleOpenEditors: number;
	private dynamicHeight: boolean;

	private model: IEditorStacksModel;
	private dirtyCountElement: HTMLElement;

	constructor(actionRunner: IActionRunner, settings: any,
		@IMessageService messageService: IMessageService,
		@IEventService private eventService: IEventService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@ITextFileService private textFileService: ITextFileService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService
	) {
		super(actionRunner, OpenEditorsView.computeExpandedBodySize(editorGroupService.getStacksModel()), !!settings[OpenEditorsView.MEMENTO_COLLAPSED], nls.localize('openEditosrSection', "Open Editors Section"), messageService, keybindingService, contextMenuService);

		this.settings = settings;
		this.model = editorGroupService.getStacksModel();
	}

	public renderHeader(container: HTMLElement): void {
		const titleDiv = dom.append(container, $('.title'));
		const titleSpan = dom.append(titleDiv, $('span'));
		titleSpan.textContent = nls.localize('openEditors', "Open Editors");

		this.dirtyCountElement = dom.append(titleDiv, $('.monaco-count-badge'));
		this.updateDirtyIndicator();

		super.renderHeader(container);
	}

	public getActions(): IAction[] {
		return [
			this.instantiationService.createInstance(SaveAllAction, SaveAllAction.ID, SaveAllAction.LABEL),
			this.instantiationService.createInstance(CloseAllEditorsAction, CloseAllEditorsAction.ID, CloseAllEditorsAction.LABEL)
		];
	}

	public renderBody(container: HTMLElement): void {
		this.treeContainer = super.renderViewTree(container);
		dom.addClass(this.treeContainer, 'explorer-open-editors');

		const dataSource = this.instantiationService.createInstance(DataSource);
		const actionProvider = this.instantiationService.createInstance(ActionProvider, this.model);
		const renderer = this.instantiationService.createInstance(Renderer, actionProvider, this.model);
		const controller = this.instantiationService.createInstance(Controller, actionProvider, this.model);
		const accessibilityProvider = this.instantiationService.createInstance(AccessibilityProvider);
		const dnd = this.instantiationService.createInstance(DragAndDrop);

		this.tree = new Tree(this.treeContainer, {
			dataSource,
			renderer,
			controller,
			accessibilityProvider,
			dnd
		}, {
			indentPixels: 0,
			twistiePixels: 20,
			ariaLabel: nls.localize('treeAriaLabel', "Open Editors")
		});

		this.updateTree({ structural: true, group: null });
	}

	public create(): TPromise<void> {

		// Load Config
		const configuration = this.configurationService.getConfiguration<IFilesConfiguration>();
		this.onConfigurationUpdated(configuration);

		// listeners
		this.registerListeners();

		return super.create();
	}

	private registerListeners(): void {

		// update on model changes
		this.toDispose.push(this.model.onModelChanged(e => this.updateTree(e)));

		// Also handle configuration updates
		this.toDispose.push(this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationUpdated(e.config)));

		// We are not updating the tree while the viewlet is not visible. Thus refresh when viewlet becomes visible #6702
		this.toDispose.push(this.eventService.addListener2(WorkbenchEventType.COMPOSITE_OPENED, (e: CompositeEvent) => {
			if (e.compositeId === VIEWLET_ID) {
				this.updateTree({ structural: true, group: null });
			}
		}));
	}

	private updateTree(e: IStacksModelChangeEvent): void {
		if (this.isDisposed || !this.isVisible) {
			return;
		}

		if (this.tree) {
			// Do a minimal tree update based on if the change is structural or not #6670
			if (e.structural) {
				// View size
				this.expandedBodySize = this.getExpandedBodySize(this.model);

				// Show groups only if there is more than 1 group
				const treeInput = this.model.groups.length === 1 ? this.model.groups[0] : this.model;
				// If an editor changed structurally it is enough to refresh the group, otherwise a group changed structurally and we need the full refresh.
				const toRefresh = e.editor ? e.group : null;
				(treeInput !== this.tree.getInput() ? this.tree.setInput(treeInput) : this.tree.refresh(toRefresh))
				// Always expand all the groups as they are unclickable
					.done(() => this.tree.expandAll(this.model.groups), errors.onUnexpectedError);
			} else {
				const toRefresh = e.editor ? new OpenEditor(e.editor, e.group) : e.group;
				this.tree.refresh(toRefresh, false).done(null, errors.onUnexpectedError);
				this.updateDirtyIndicator();
			}
		}

		// Make sure to keep active open editor highlighted
		if (this.model.activeGroup && this.model.activeGroup.activeEditor /* could be empty */) {
			this.highlightEntry(new OpenEditor(this.model.activeGroup.activeEditor, this.model.activeGroup));
		}
	}

	private highlightEntry(entry: OpenEditor): void {
		this.tree.clearFocus();
		this.tree.clearSelection();

		if (entry) {
			this.tree.setFocus(entry);
			this.tree.setSelection([entry]);
			this.tree.reveal(entry).done(null, errors.onUnexpectedError);
		}
	}

	private onConfigurationUpdated(configuration: IFilesConfiguration): void {
		let visibleOpenEditors = configuration && configuration.explorer && configuration.explorer.openEditors && configuration.explorer.openEditors.visible;
		if (typeof visibleOpenEditors === 'number') {
			this.visibleOpenEditors = visibleOpenEditors;
		} else {
			this.visibleOpenEditors = OpenEditorsView.DEFAULT_VISIBLE_OPEN_EDITORS;
		}

		let dynamicHeight = configuration && configuration.explorer && configuration.explorer.openEditors && configuration.explorer.openEditors.dynamicHeight;
		if (typeof dynamicHeight === 'boolean') {
			this.dynamicHeight = dynamicHeight;
		} else {
			this.dynamicHeight = OpenEditorsView.DEFAULT_DYNAMIC_HEIGHT;
		}

		// Adjust expanded body size
		this.expandedBodySize = this.getExpandedBodySize(this.model);
	}

	private updateDirtyIndicator(): void {
		let dirty = this.textFileService.getAutoSaveMode() !== AutoSaveMode.AFTER_SHORT_DELAY ? this.textFileService.getDirty().length
			: this.untitledEditorService.getDirty().length;
		if (dirty === 0) {
			dom.addClass(this.dirtyCountElement, 'hidden');
		} else {
			this.dirtyCountElement.textContent = nls.localize('dirtyCounter', "{0} unsaved", dirty);
			dom.removeClass(this.dirtyCountElement, 'hidden');
		}
	}

	private getExpandedBodySize(model: IEditorStacksModel): number {
		return OpenEditorsView.computeExpandedBodySize(model, this.visibleOpenEditors, this.dynamicHeight);
	}

	private static computeExpandedBodySize(model: IEditorStacksModel, visibleOpenEditors = OpenEditorsView.DEFAULT_VISIBLE_OPEN_EDITORS, dynamicHeight = OpenEditorsView.DEFAULT_DYNAMIC_HEIGHT): number {
		let entryCount = model.groups.reduce((sum, group) => sum + group.count, 0);
		// We only show the group labels if there is more than 1 group
		if (model.groups.length > 1) {
			entryCount += model.groups.length;
		}

		let itemsToShow: number;
		if (dynamicHeight) {
			itemsToShow = Math.min(Math.max(visibleOpenEditors, 1), entryCount);
		} else {
			itemsToShow = Math.max(visibleOpenEditors, 1);
		}

		return itemsToShow * Renderer.ITEM_HEIGHT;
	}

	public getOptimalWidth():number {
		let parentNode = this.tree.getHTMLElement();
		let childNodes = [].slice.call(parentNode.querySelectorAll('.monaco-file-label > .file-name'));
		return dom.getLargestChildWidth(parentNode, childNodes);
	}

	public shutdown(): void {
		this.settings[OpenEditorsView.MEMENTO_COLLAPSED] = (this.state === CollapsibleState.COLLAPSED);

		super.shutdown();
	}
}