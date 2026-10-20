#!/usr/bin/env python3
"""Plot synthetic economy traces. Missing market quotes remain missing."""
import argparse
import json
from pathlib import Path
import statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def render(root: Path):
    runs = json.loads((root / "runs.json").read_text())
    all_runs = runs
    runs = [r for r in runs if r["model"]["name"] == "reference"]
    names = list(dict.fromkeys(r["scenario"] for r in runs))
    plt.rcParams.update({"font.size": 9, "axes.spines.top": False,
                        "axes.spines.right": False, "figure.facecolor": "white"})
    fig, axes = plt.subplots(4, 3, figsize=(15, 13), constrained_layout=True)
    for ax, name in zip(axes.flat, names):
        for mode, color, label in [("adaptive", "#0969a3", "Adaptive"),
                                    ("fixed_baseline", "#ad6a24", "Fixed neutral")]:
            selected = [r for r in runs if r["scenario"] == name and r["mode"] == mode]
            n = len(selected[0]["days"])
            samples = [[d["active_money"] / (d["qualified"] * 70000)
                        if d["qualified"] else float("nan") for d in r["days"]]
                       for r in selected]
            x, med, low, high = [], [], [], []
            for day in range(n):
                values = sorted(row[day] for row in samples if row[day] == row[day])
                if not values:
                    continue
                x.append(day + 1); med.append(statistics.median(values))
                low.append(values[0]); high.append(values[-1])
            ax.plot(x, med, color=color, label=label, linewidth=1.5)
            ax.fill_between(x, low, high, color=color, alpha=.12)
        ax.axhspan(.9, 1.1, color="#388348", alpha=.12)
        ax.axhline(1, color="#52676d", linewidth=.7, linestyle="--")
        ax.set(title=name.replace("_", " "), xlabel="Simulated day", ylabel="Active coins / 70k target")
        ax.set_ylim(bottom=0)
    axes.flat[0].legend()
    fig.suptitle("Reference assumptions: median and full range across eight seeds\n"
                 "Green band is ±10% of the per-player target; not a confidence interval", fontsize=14)
    fig.savefig(root / "money.png", dpi=150)
    fig.savefig(root / "money.svg", metadata={"Date": None})
    plt.close(fig)

    fig, axes = plt.subplots(4, 3, figsize=(15, 13), constrained_layout=True)
    for ax, name in zip(axes.flat, names):
        selected = [r for r in runs if r["scenario"] == name and r["mode"] == "adaptive"]
        # One explicitly identified seed avoids inventing a median market price
        # across worlds where the starter basket is not actually available.
        r = next(r for r in selected if r["seed"] == 42)
        ds = r["days"]
        ax.plot([d["day"] for d in ds],
                [d["beginner_minutes"] if d["beginner_minutes"] is not None
                 else float("nan") for d in ds], color="#0969a3", linewidth=1, marker=".", markersize=1.2)
        ax.axhline(60, color="#a53232", linestyle="--", linewidth=.8)
        missing = sum(d["starter_quote"] is None for d in ds)
        beyond = sum(d["beginner_beyond_year"] for d in ds)
        ax.set(title=f"{name.replace('_', ' ')}\n{missing} no-stock days; {beyond} beyond one year",
               xlabel="Simulated day", ylabel="Beginner active minutes (log scale)")
        ax.set_yscale("symlog", linthresh=10)
        ax.set_xlim(1, len(ds))
        ax.set_ylim(bottom=-1)
        if all(d["beginner_minutes"] is None for d in ds):
            ax.text(.5, .4, "No complete, affordable quote\nwithin the one-year probe", transform=ax.transAxes,
                    ha="center", va="center", color="#52676d", fontsize=9)
    fig.suptitle("Reference assumptions · starter market affordability · seed 42 · adaptive policy\n"
                 "Gaps mean no complete quote or beyond probe horizon; red line is 60 minutes", fontsize=14)
    fig.savefig(root / "affordability.png", dpi=150)
    fig.savefig(root / "affordability.svg", metadata={"Date": None})
    plt.close(fig)

    models = list(dict.fromkeys(r["model"]["name"] for r in all_runs))
    fig, axes = plt.subplots(2, 1, figsize=(15, 7), constrained_layout=True)
    for ax, metric, title in [
        (axes[0], "market", "Market affordability: passed seeds / 8 (unchanged release objective)"),
        (axes[1], "kit", "Late newcomers completing equipment: players / 24 (mixed buying and gathering)")]:
        values, labels = [], []
        for model in models:
            row, text = [], []
            for name in names:
                group = [r for r in all_runs if r["model"]["name"] == model
                         and r["scenario"] == name and r["mode"] == "adaptive"]
                if metric == "market":
                    done = sum(r["acceptance"]["starter_affordability_met"] for r in group)
                    total = len(group)
                else:
                    cohorts = [c for r in group for c in r["newcomer_cohorts"] if c["joined_day"] == 301]
                    done = sum(c["kits"] for c in cohorts)
                    total = sum(c["players"] for c in cohorts)
                row.append(done / total if total else float("nan"))
                text.append(f"{done}/{total}")
            values.append(row); labels.append(text)
        ax.imshow(values, vmin=0, vmax=1, cmap="Blues", aspect="auto")
        ax.set_xticks(range(len(names)), [n.replace("_", " ") for n in names], rotation=25, ha="right")
        ax.set_yticks(range(len(models)), [m.replace("_", " ") for m in models])
        for y, row in enumerate(values):
            for x, value in enumerate(row):
                ax.text(x, y, labels[y][x], ha="center", va="center",
                        color="white" if value > .6 else "#172b38", fontsize=9)
        ax.set_title(title)
    fig.suptitle("Uncalibrated sensitivity: the market quote and actual equipment progression measure different outcomes", fontsize=13)
    fig.savefig(root / "sensitivity.png", dpi=150)
    fig.savefig(root / "sensitivity.svg", metadata={"Date": None})
    plt.close(fig)

    if (root / "comparison.json").exists():
        comparison = json.loads((root / "comparison.json").read_text())
        variants = list(dict.fromkeys(r["variant"] for r in comparison))
        flows = ["# Experimental coin flows", "",
                 "Arithmetic means of 16 normal-population runs per row (stable/growing, all eight seeds). Individual runs reconcile exactly. Rounded displayed means can differ by a coin. These are simulated flows, not server revenue.", "",
                 "| Variant / assumptions | Starter grants | Quest coins | Market fees removed | Services removed | Net games removed | Final total coins | NPC iron / food |",
                 "|---|---:|---:|---:|---:|---:|---:|---:|"]
        for variant in variants:
            for model in models:
                group = [r for r in comparison if r["variant"] == variant and r["model"]["name"] == model
                         and r["scenario"] in ("stable_20", "growth_5_to_20")]
                def average(key):
                    return statistics.mean(r["accounting"][key] for r in group)
                games = statistics.mean(r["accounting"]["stakes"]-r["accounting"]["payouts"] for r in group)
                final = statistics.mean(r["final_day"]["total_money"] for r in group)
                iron = statistics.mean(r["accounting"]["contract_goods"][0] for r in group)
                food = statistics.mean(r["accounting"]["contract_goods"][1] for r in group)
                flows.append(f"| {variant} / {model} | {average('grants'):.0f} | {average('quests'):.0f} | {average('commission'):.0f} | {average('services'):.0f} | {games:.0f} | {final:.0f} | {iron:.1f} / {food:.1f} |")
        (root / "flows-comparison.md").write_text("\n".join(flows)+"\n")

        stress = ["# Experimental stress comparisons", "",
                  "Synthetic assumptions only. Stress cases are reported separately; optional nonparticipation and scarcity are not promised to meet every normal-population objective.", "",
                  "Each row pools all five assumption sets and eight seeds (40 runs, 120 late newcomers). Full per-model traces remain in the raw reports.", "",
                  "| Variant / scenario | Money passed | Market passed | Late kits | Late kits within 60 min | Active-money ratio median [min, max] |",
                  "|---|---:|---:|---:|---:|---:|"]
        stress_names = [n for n in names if n not in ("stable_20", "growth_5_to_20")]
        for variant in variants:
            for name in stress_names:
                group = [r for r in comparison if r["variant"] == variant and r["scenario"] == name]
                cohorts = [c for r in group for c in r["newcomer_cohorts"] if c["joined_day"] == 301]
                count = len(group)
                money = sum(r["acceptance"]["money_target_met"] for r in group)
                market = sum(r["acceptance"]["starter_affordability_met"] for r in group)
                total = sum(c["players"] for c in cohorts)
                kits = sum(c["kits"] for c in cohorts)
                timely = sum(c["kits_within_60_minutes"] for c in cohorts)
                ratios = [r["acceptance"]["tail_money_ratio"] for r in group
                          if r["acceptance"]["tail_money_ratio"] is not None]
                ratio_text = (f"{statistics.median(ratios):.2f} [{min(ratios):.2f}, {max(ratios):.2f}]"
                              if ratios else "Unknown")
                stress.append(f"| {variant} / {name} | {money}/{count} | {market}/{count} | {kits}/{total} | {timely}/{total} | {ratio_text} |")
        (root / "stress-comparison.md").write_text("\n".join(stress) + "\n")

        fig, axes = plt.subplots(1, 3, figsize=(16, 6), constrained_layout=True)
        titles = ["Money target: passed runs / 16", "Market affordability: passed runs / 16",
                  "Late kits within 60 active minutes: players / 48"]
        for ax, metric, title in zip(axes, ["money", "market", "kit"], titles):
            matrix, annotations = [], []
            for variant in variants:
                row, texts = [], []
                for model in models:
                    group = [r for r in comparison if r["variant"] == variant and r["model"]["name"] == model
                             and r["scenario"] in ("stable_20", "growth_5_to_20")]
                    if metric == "kit":
                        cohorts = [c for r in group for c in r["newcomer_cohorts"] if c["joined_day"] == 301]
                        done = sum(c["kits_within_60_minutes"] for c in cohorts)
                        total = sum(c["players"] for c in cohorts)
                    else:
                        key = "money_target_met" if metric == "money" else "starter_affordability_met"
                        done = sum(r["acceptance"][key] for r in group)
                        total = len(group)
                    row.append(done / total if total else float("nan")); texts.append(f"{done}/{total}")
                matrix.append(row); annotations.append(texts)
            ax.imshow(matrix, vmin=0, vmax=1, cmap="Blues", aspect="auto")
            ax.set_xticks(range(len(models)), [m.replace("_", " ") for m in models], rotation=35, ha="right")
            ax.set_yticks(range(len(variants)), ["implemented" if v == "current" else v.replace("_", " ") for v in variants])
            for y, row in enumerate(matrix):
                for x, value in enumerate(row):
                    ax.text(x, y, annotations[y][x], ha="center", va="center",
                            color="white" if value > .6 else "#172b38", fontsize=10)
            ax.set_title(title)
        fig.suptitle("Implemented rules and historical candidates · normal populations · all seeds\n"
                     "Implemented: coin budget, iron-work onboarding and repairs; no free materials or XP", fontsize=13)
        fig.savefig(root / "comparison.png", dpi=150)
        fig.savefig(root / "comparison.svg", metadata={"Date": None})
        plt.close(fig)

        fig, ax = plt.subplots(figsize=(12, 5), constrained_layout=True)
        for color, variant in zip(plt.get_cmap("tab10").colors, variants):
            paths = [r["reference_money_path"] for r in comparison if r["variant"] == variant
                     and r["model"]["name"] == "reference" and r["scenario"] == "stable_20"]
            xs, medians = [], []
            for day in range(len(paths[0])):
                values = [p[day] for p in paths if p[day] is not None]
                if values:
                    xs.append(day+1); medians.append(statistics.median(values))
            ax.plot(xs, medians, label=variant.replace("_", " "), color=color, linewidth=1.5)
        ax.axhspan(.5, 1.5, color="#697d88", alpha=.08, label="Release money range")
        ax.axhspan(.9, 1.1, color="#388348", alpha=.16, label="Controller neutral band")
        ax.axhline(1, color="#52676d", linestyle="--", linewidth=.7)
        ax.set(xlabel="Simulated day", ylabel="Active coins / 70k target", ylim=(0, None),
               title="Reference assumptions, stable population · median across eight seeds\n"
                     "Only the simulator changes; voluntary-service uptake and gathering rates are uncalibrated")
        ax.legend(ncols=3, fontsize=8)
        fig.savefig(root / "comparison-money.png", dpi=150)
        fig.savefig(root / "comparison-money.svg", metadata={"Date": None})
        plt.close(fig)

    # A self-contained index uses local image links; no CDN or remote requests.
    (root / "index.html").write_text("""<!doctype html><html lang="en"><meta charset="utf-8">
<title>Economy simulations</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;max-width:1500px;margin:2rem auto;padding:0 1rem;color:#172b38}img{max-width:100%;height:auto}p{max-width:80ch}a{color:#0969a3}</style>
<h1>Synthetic economy simulations</h1><p>These are virtual players and assumed goods markets, not live server measurements.
Read the assumptions and failures before treating any curve as a prediction.</p>
<p><a href="comparison.md">Experimental comparison</a> · <a href="stress-comparison.md">Stress cases</a> · <a href="flows-comparison.md">Coin flows</a> · <a href="summary.md">Current economy</a> · <a href="acceptance.json">Release acceptance</a> ·
<a href="manifest.json">Assumptions and source hash</a> · <a href="daily.csv">Daily CSV</a> · <a href="runs.json">Raw runs</a></p>
<img src="comparison.png" alt="Experimental budgets, services and starter rewards compared across assumptions">
<img src="comparison-money.png" alt="Money supply under each experimental policy">
<img src="sensitivity.png" alt="Five assumption sets compared across all scenarios">
<img src="money.png" alt="Active money compared with target across twelve scenarios">
<img src="affordability.png" alt="Starter affordability with missing market quotes shown as gaps"></html>""")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path, default=Path("reports/economy"))
    render(parser.parse_args().directory)
