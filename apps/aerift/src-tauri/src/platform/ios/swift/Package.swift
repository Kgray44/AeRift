// swift-tools-version: 5.7

import PackageDescription

let package = Package(
    name: "tauri-plugin-aerift-ios",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "tauri-plugin-aerift-ios", type: .static, targets: ["AeRiftIos"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(name: "AeRiftIos", dependencies: ["Tauri"], path: "Sources")
    ]
)
