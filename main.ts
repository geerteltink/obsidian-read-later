import { Notice, Plugin, TFile } from "obsidian";
import Parser from "rss-parser";
import { format } from "date-fns/format";

export default class ReadLaterPlugin extends Plugin {
	async onload() {
		await this.updateFeeds();

		// This function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => this.updateFeeds(), 60 * 60 * 1000)
		);
	}

	onunload() {}

	async updateFeeds() {
		const folder = this.app.vault.getFolderByPath("read later");
		if (folder === null) {
			console.error("Read Later - Folder does not exist");
			return;
		}

		console.log("Read Later - Syncing feeds");

		for (const category of folder.children) {
			if (category instanceof TFile) {
				const lastSynced = this.extractSyncedTime(category);
				const feeds = this.extractFeeds(category);
				if (feeds === null) {
					return;
				}

				for (const feed of feeds) {
					await this.updateFeed(category, feed, lastSynced);
					await this.updateSyncedTime(category);
				}
			}
		}
	}

	extractSyncedTime(category: TFile): Date {
		const metadataCache = this.app.metadataCache.getFileCache(category);
		const frontMatterCache = metadataCache?.frontmatter;

		const defaultDate = new Date();
		defaultDate.setFullYear(new Date().getFullYear() - 3);

		if (frontMatterCache === undefined || !frontMatterCache.xml_synced) {
			return defaultDate;
		}

		return new Date(frontMatterCache.xml_synced);
	}

	extractFeeds(category: TFile): string[] | null {
		const metadataCache = this.app.metadataCache.getFileCache(category);
		const frontMatterCache = metadataCache?.frontmatter;

		if (frontMatterCache === undefined) {
			return null;
		}

		return frontMatterCache.xml_feeds;
	}

	async updateFeed(file: TFile, url: string, lastSynced: Date) {
		let content = await this.app.vault.read(file);
		const parser = new Parser({
			defaultRSS: 2.0,
			timeout: 10000,
		});

		try {
			const feed = await parser.parseURL(url);
			for (const entry of feed.items) {
				if (!entry.isoDate || lastSynced < new Date(entry.isoDate)) {
					content.trimEnd();
					content += `- [ ] [${entry.title}](${entry.link}) _(${
						feed.title ?? feed.link
					})_\n`;
				}
			}
		} catch (error) {
			return;
		}

		await this.app.vault.modify(file, content);
	}

	async updateSyncedTime(file: TFile) {
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					frontmatter["xml_synced"] = formatTimestamp(
						file.stat.mtime
					);
				}
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			if (e?.name === "YAMLParseError") {
				const errorMessage = `Timestamp failed to update because of malformed frontmatter on this file : ${file.path} ${e.message}`;
				new Notice(errorMessage, 4000);
				console.error(errorMessage);
				return {
					status: "error",
					error: e,
				};
			}
		}
	}
}

function formatTimestamp(input: number): string {
	return format(new Date(input), "yyyy-MM-dd'T'HH:mm");
}
